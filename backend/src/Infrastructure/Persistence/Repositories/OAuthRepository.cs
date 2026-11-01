using Application.Auth;
using Application.Identity;
using Dapper;
using Domain.Identity;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IOAuthRepository"/> on <c>textstack_v2</c>. Every one-time step
/// (approve, deny, burn a code, rotate) is a single guarded UPDATE, so of two racing callers exactly
/// one matches the row. Hashes are unique (<c>ix_oauth_*_hash</c>), and an approved request dies with
/// its account (<c>fk_oauth_authorization_requests_users_user_id</c>).
/// </summary>
public sealed class OAuthRepository(V2DataSource dataSource) : IOAuthRepository
{
    private const string ClientColumns = "id, client_id, client_name, redirect_uris, is_metadata_document, fetched_at, created_at";

    private const string RequestColumns =
        "id, client_id, client_name, redirect_uri, state, code_challenge, resource, scope, expires_at, user_id, code_hash, denied_at, consumed_at, created_at";
    private const string GrantColumns =
        "id, user_id, client_id, client_name, redirect_uri, resource, scope, access_token_hash, access_token_expires_at, refresh_token_hash, refresh_token_expires_at, previous_refresh_token_hash, last_used_at, revoked_at, created_at";

    private const string SelectClient = $"SELECT {ClientColumns} FROM oauth_clients WHERE client_id = @clientId";

    public Task<OAuthClientRegistration?> GetClientAsync(string clientId, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthClientRegistration>(SelectClient, new { clientId }, ct);

    // A concurrent first fetch of the same metadata document lands on the conflict: last write wins.
    private const string UpsertClient = $"""
        INSERT INTO oauth_clients (id, client_id, client_name, redirect_uris, is_metadata_document, fetched_at, created_at)
        VALUES (@Id, @ClientId, @ClientName, @RedirectUris, @IsMetadataDocument, @FetchedAt, now())
        ON CONFLICT (client_id) DO UPDATE SET
            client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris, fetched_at = EXCLUDED.fetched_at
        RETURNING {ClientColumns}
        """;

    public async Task<OAuthClientRegistration> SaveClientAsync(OAuthClientRegistration client, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<OAuthClientRegistration>(new CommandDefinition(UpsertClient, client, cancellationToken: ct));
    }

    private const string InsertRequest = """
        INSERT INTO oauth_authorization_requests (id, client_id, client_name, redirect_uri, state, code_challenge, resource, scope, expires_at, created_at)
        VALUES (@Id, @ClientId, @ClientName, @RedirectUri, @State, @CodeChallenge, @Resource, @Scope, @ExpiresAt, now())
        """;

    public Task CreateRequestAsync(OAuthAuthorization request, CancellationToken ct) => ExecuteAsync(InsertRequest, request, ct);

    private const string SelectRequest = $"SELECT {RequestColumns} FROM oauth_authorization_requests WHERE id = @requestId";

    public Task<OAuthAuthorization?> GetRequestAsync(Guid requestId, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthAuthorization>(SelectRequest, new { requestId }, ct);

    // "Pending" is the consent page's status: neither decided nor expired.
    private const string ApproveRequest = $"""
        UPDATE oauth_authorization_requests SET user_id = @userId, code_hash = @codeHash, expires_at = @codeExpiresAt
        WHERE id = @requestId AND denied_at IS NULL AND user_id IS NULL AND expires_at > @now
        RETURNING {RequestColumns}
        """;

    public Task<OAuthAuthorization?> ApproveRequestAsync(
        Guid requestId, Guid userId, string codeHash, DateTimeOffset codeExpiresAt, DateTimeOffset now, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthAuthorization>(ApproveRequest, new { requestId, userId, codeHash, codeExpiresAt, now }, ct);

    private const string DenyRequest = """
        UPDATE oauth_authorization_requests SET denied_at = @now
        WHERE id = @requestId AND denied_at IS NULL AND user_id IS NULL AND expires_at > @now
        """;

    public async Task<bool> DenyRequestAsync(Guid requestId, DateTimeOffset now, CancellationToken ct) =>
        await ExecuteAsync(DenyRequest, new { requestId, now }, ct) > 0;

    private const string SelectRequestByCode = $"SELECT {RequestColumns} FROM oauth_authorization_requests WHERE code_hash = @codeHash";

    public Task<OAuthAuthorization?> GetRequestByCodeAsync(string codeHash, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthAuthorization>(SelectRequestByCode, new { codeHash }, ct);

    private const string BurnCode = "UPDATE oauth_authorization_requests SET consumed_at = @now WHERE id = @requestId AND consumed_at IS NULL";

    public async Task<bool> BurnCodeAsync(Guid requestId, DateTimeOffset now, CancellationToken ct) =>
        await ExecuteAsync(BurnCode, new { requestId, now }, ct) > 0;

    private const string DeleteOldRequests = "DELETE FROM oauth_authorization_requests WHERE created_at < @createdBefore";

    public Task<int> DeleteRequestsCreatedBeforeAsync(DateTimeOffset createdBefore, CancellationToken ct) =>
        ExecuteAsync(DeleteOldRequests, new { createdBefore }, ct);

    // The owner filter is here; the revoke below only touches the ids this select returned.
    // ponytail: two connects of one app at the same instant can both stay live (as on legacy); FOR UPDATE here if that ever shows up.
    private const string SelectLiveGrantsOfClient = """
        SELECT id, redirect_uri FROM oauth_grants
        WHERE user_id = @userId AND client_name = @clientName AND revoked_at IS NULL
        """;

    private const string RevokeGrants = "UPDATE oauth_grants SET revoked_at = now() WHERE id = ANY(@ids)";
    private const string InsertGrant = """
        INSERT INTO oauth_grants (id, user_id, client_id, client_name, redirect_uri, resource, scope, access_token_hash, access_token_expires_at, refresh_token_hash, refresh_token_expires_at, created_at)
        VALUES (@Id, @UserId, @ClientId, @ClientName, @RedirectUri, @Resource, @Scope, @AccessTokenHash, @AccessTokenExpiresAt, @RefreshTokenHash, @RefreshTokenExpiresAt, now())
        """;

    public async Task ConnectAsync(Guid userId, OAuthTokenGrant grant, CancellationToken ct)
    {
        // The host is compared as the consent screen shows it (OAuth.DisplayHost), which SQL cannot reproduce.
        var host = OAuth.DisplayHost(grant.RedirectUri);
        var args = new DynamicParameters(grant);
        args.Add("UserId", userId);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var live = await conn.QueryAsync<(Guid Id, string RedirectUri)>(
            new CommandDefinition(SelectLiveGrantsOfClient, new { userId, grant.ClientName }, tx, cancellationToken: ct));
        var ids = live.Where(g => OAuth.DisplayHost(g.RedirectUri) == host).Select(g => g.Id).ToArray();
        await conn.ExecuteAsync(new CommandDefinition(RevokeGrants, new { ids }, tx, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition(InsertGrant, args, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
    }

    private const string SelectByRefreshToken = $"SELECT {GrantColumns} FROM oauth_grants WHERE refresh_token_hash = @refreshTokenHash AND revoked_at IS NULL";

    public Task<OAuthTokenGrant?> GetByRefreshTokenAsync(string refreshTokenHash, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthTokenGrant>(SelectByRefreshToken, new { refreshTokenHash }, ct);

    // ponytail: remembers one generation back (previous_refresh_token_hash); an older spent token is refused but not treated as reuse.
    private const string RevokeOnReuse = """
        UPDATE oauth_grants SET revoked_at = @now
        WHERE previous_refresh_token_hash = @refreshTokenHash AND revoked_at IS NULL
        """;

    public Task<int> RevokeOnRefreshReuseAsync(string refreshTokenHash, DateTimeOffset now, CancellationToken ct) =>
        ExecuteAsync(RevokeOnReuse, new { refreshTokenHash, now }, ct);

    private const string RotateGrant = """
        UPDATE oauth_grants SET
            access_token_hash = @accessTokenHash,
            access_token_expires_at = @accessTokenExpiresAt,
            previous_refresh_token_hash = refresh_token_hash,
            refresh_token_hash = @refreshTokenHash,
            refresh_token_expires_at = @refreshTokenExpiresAt,
            last_used_at = @now
        WHERE id = @grantId AND refresh_token_hash = @oldRefreshTokenHash AND revoked_at IS NULL
        """;

    public async Task<bool> RotateAsync(
        Guid grantId, string oldRefreshTokenHash,
        string accessTokenHash, DateTimeOffset accessTokenExpiresAt,
        string refreshTokenHash, DateTimeOffset refreshTokenExpiresAt,
        DateTimeOffset now, CancellationToken ct) =>
        await ExecuteAsync(RotateGrant, new
        {
            grantId,
            oldRefreshTokenHash,
            accessTokenHash,
            accessTokenExpiresAt,
            refreshTokenHash,
            refreshTokenExpiresAt,
            now,
        }, ct) > 0;

    private const string RevokeByToken = """
        UPDATE oauth_grants SET revoked_at = @now
        WHERE (access_token_hash = @tokenHash OR refresh_token_hash = @tokenHash) AND revoked_at IS NULL
        """;

    public Task<int> RevokeByTokenAsync(string tokenHash, DateTimeOffset now, CancellationToken ct) =>
        ExecuteAsync(RevokeByToken, new { tokenHash, now }, ct);

    private const string SelectByAccessToken = $"""
        SELECT {GrantColumns} FROM oauth_grants
        WHERE access_token_hash = @accessTokenHash AND revoked_at IS NULL AND access_token_expires_at > @now AND resource = @resource
        """;

    public Task<OAuthTokenGrant?> GetByAccessTokenAsync(string accessTokenHash, string resource, DateTimeOffset now, CancellationToken ct) =>
        QuerySingleOrDefaultAsync<OAuthTokenGrant>(SelectByAccessToken, new { accessTokenHash, resource, now }, ct);

    private const string TouchGrant = "UPDATE oauth_grants SET last_used_at = @now WHERE id = @grantId";

    public Task TouchAsync(Guid grantId, DateTimeOffset now, CancellationToken ct) => ExecuteAsync(TouchGrant, new { grantId, now }, ct);

    private const string SelectLiveGrantsOfUser = $"""
        SELECT {GrantColumns} FROM oauth_grants
        WHERE user_id = @userId AND revoked_at IS NULL AND refresh_token_expires_at > @now
        ORDER BY created_at DESC, id DESC
        """;

    public async Task<IReadOnlyList<OAuthTokenGrant>> ListLiveAsync(Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<OAuthTokenGrant>(new CommandDefinition(SelectLiveGrantsOfUser, new { userId, now }, cancellationToken: ct))).AsList();
    }

    // COALESCE keeps the first revocation time: the audit answer is "when was it turned off".
    private const string RevokeGrantOfUser = "UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, @now) WHERE user_id = @userId AND id = @grantId";

    public async Task<bool> RevokeAsync(Guid userId, Guid grantId, DateTimeOffset now, CancellationToken ct) =>
        await ExecuteAsync(RevokeGrantOfUser, new { userId, grantId, now }, ct) > 0;

    private const string DeleteDeadGrants = "DELETE FROM oauth_grants WHERE revoked_at < @before OR refresh_token_expires_at < @before";

    public Task<int> DeleteDeadGrantsAsync(DateTimeOffset before, CancellationToken ct) => ExecuteAsync(DeleteDeadGrants, new { before }, ct);

    private async Task<T?> QuerySingleOrDefaultAsync<T>(string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    private async Task<int> ExecuteAsync(string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: ct));
    }
}
