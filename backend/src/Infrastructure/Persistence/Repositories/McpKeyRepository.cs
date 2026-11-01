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

    private const string InsertKey = $"""
        INSERT INTO mcp_access_keys (id, user_id, name, key_hash, prefix, created_at)
        VALUES (gen_random_uuid(), @userId, @name, @keyHash, @prefix, now())
        RETURNING {Columns}
        """;

    public async Task<McpConnectKey> CreateAsync(Guid userId, string name, string keyHash, string prefix, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<McpConnectKey>(new CommandDefinition(InsertKey, new { userId, name, keyHash, prefix }, cancellationToken: ct));
    }

    // COALESCE keeps the first revocation time: the audit answer is "when was it turned off".
    private const string RevokeKeyOfUser = "UPDATE mcp_access_keys SET revoked_at = COALESCE(revoked_at, @now) WHERE user_id = @userId AND id = @keyId";

    public async Task<bool> RevokeAsync(Guid userId, Guid keyId, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RevokeKeyOfUser, new { userId, keyId, now }, cancellationToken: ct)) > 0;
    }

    private const string SelectLiveByHash = $"SELECT {Columns} FROM mcp_access_keys WHERE key_hash = @keyHash AND revoked_at IS NULL";

    public async Task<McpConnectKey?> GetLiveByHashAsync(string keyHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<McpConnectKey>(new CommandDefinition(SelectLiveByHash, new { keyHash }, cancellationToken: ct));
    }

    private const string TouchKey = "UPDATE mcp_access_keys SET last_used_at = @now WHERE id = @keyId";

    public async Task TouchAsync(Guid keyId, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(TouchKey, new { keyId, now }, cancellationToken: ct));
    }
}
