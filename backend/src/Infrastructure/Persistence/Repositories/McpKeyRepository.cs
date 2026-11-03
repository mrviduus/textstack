using Application.Identity;
using Dapper;
using Domain.Identity;

namespace Infrastructure.Persistence.Repositories;

/// <summary>Dapper implementation of <see cref="IMcpKeyRepository"/> on <c>textstack_v2</c>; a key hash is unique (<c>ix_mcp_access_keys_key_hash</c>).</summary>
public sealed class McpKeyRepository(V2DataSource dataSource) : IMcpKeyRepository
{
    private const string Columns = "id, user_id, name, key_hash, prefix, last_used_at, revoked_at, created_at";

    private const string SelectKeysOfUser = $"SELECT {Columns} FROM mcp_access_keys WHERE user_id = @userId ORDER BY created_at DESC, id DESC";

    public async Task<IReadOnlyList<McpConnectKey>> ListAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<McpConnectKey>(new CommandDefinition(SelectKeysOfUser, new { userId }, cancellationToken: ct))).AsList();
    }

    private const string CountLiveKeys = "SELECT count(*) FROM mcp_access_keys WHERE user_id = @userId AND revoked_at IS NULL";

    public async Task<int> CountLiveAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<int>(new CommandDefinition(CountLiveKeys, new { userId }, cancellationToken: ct));
    }

    // The user's row FOR SHARE (SessionTokenRepository's lock order): a reset committing meanwhile is
    // seen by the stamp, one coming after sees the key and revokes it.
    private const string InsertKey = $"""
        INSERT INTO mcp_access_keys (id, user_id, name, key_hash, prefix, created_at)
        SELECT gen_random_uuid(), u.id, @name, @keyHash, @prefix, now() FROM users u
        -- A guest mints no key: a key is a persistent assistant credential (#1120).
        WHERE u.id = @userId AND NOT u.is_guest AND {UserRepository.NotResetSinceToken}
        FOR SHARE
        RETURNING {Columns}
        """;

    public async Task<McpConnectKey?> CreateAsync(Guid userId, string name, string keyHash, string prefix, DateTimeOffset tokenIssuedAt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<McpConnectKey>(new CommandDefinition(
            InsertKey, new { userId, name, keyHash, prefix, tokenIssuedAt }, cancellationToken: ct));
    }

    // COALESCE keeps the first revocation time: the audit answer is "when was it turned off".
    private const string RevokeKeyOfUser = "UPDATE mcp_access_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = @userId AND id = @keyId";

    public async Task<bool> RevokeAsync(Guid userId, Guid keyId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RevokeKeyOfUser, new { userId, keyId }, cancellationToken: ct)) > 0;
    }

    // A guest's key (minted before #1120) authenticates nothing.
    private const string SelectLiveByHash = """
        SELECT k.id, k.user_id, k.name, k.key_hash, k.prefix, k.last_used_at, k.revoked_at, k.created_at
        FROM mcp_access_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = @keyHash AND k.revoked_at IS NULL AND NOT u.is_guest
        """;

    public async Task<McpConnectKey?> GetLiveByHashAsync(string keyHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<McpConnectKey>(new CommandDefinition(SelectLiveByHash, new { keyHash }, cancellationToken: ct));
    }

    private const string TouchKey = "UPDATE mcp_access_keys SET last_used_at = now() WHERE id = @keyId";

    public async Task TouchAsync(Guid keyId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(TouchKey, new { keyId }, cancellationToken: ct));
    }
}
