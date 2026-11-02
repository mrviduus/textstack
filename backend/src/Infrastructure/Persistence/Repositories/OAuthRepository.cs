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

    public async Task<OAuthClientRegistration?> GetClientAsync(string clientId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthClientRegistration>(new CommandDefinition(SelectClient, new { clientId }, cancellationToken: ct));
    }

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

    public async Task CreateRequestAsync(OAuthAuthorization request, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertRequest, request, cancellationToken: ct));
    }

    private const string SelectRequest = $"SELECT {RequestColumns} FROM oauth_authorization_requests WHERE id = @requestId";

    public async Task<OAuthAuthorization?> GetRequestAsync(Guid requestId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthAuthorization>(new CommandDefinition(SelectRequest, new { requestId }, cancellationToken: ct));
    }

    // The consent page's "pending": neither decided nor past its deadline.
    private const string Pending = "id = @requestId AND denied_at IS NULL AND user_id IS NULL AND expires_at > @now";

    // The approver's row FOR SHARE, as a device approval: a reset committing meanwhile refuses an
    // access token from before it, and one that comes after expires the approved request.
    private const string ApproveRequest = $"""
        UPDATE oauth_authorization_requests SET user_id = @userId, code_hash = @codeHash, expires_at = @codeExpiresAt
        WHERE {Pending}
          AND EXISTS (SELECT FROM users u WHERE u.id = @userId AND {UserRepository.NotResetSinceToken} FOR SHARE)
        RETURNING {RequestColumns}
        """;

    public async Task<OAuthAuthorization?> ApproveRequestAsync(
        Guid requestId, Guid userId, string codeHash, DateTimeOffset codeExpiresAt, DateTimeOffset tokenIssuedAt, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthAuthorization>(new CommandDefinition(
            ApproveRequest, new { requestId, userId, codeHash, codeExpiresAt, tokenIssuedAt, now }, cancellationToken: ct));
    }

    private const string DenyRequest = $"UPDATE oauth_authorization_requests SET denied_at = now() WHERE {Pending}";

    public async Task<bool> DenyRequestAsync(Guid requestId, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DenyRequest, new { requestId, now }, cancellationToken: ct)) > 0;
    }

    private const string SelectRequestByCode = $"SELECT {RequestColumns} FROM oauth_authorization_requests WHERE code_hash = @codeHash";

    public async Task<OAuthAuthorization?> GetRequestByCodeAsync(string codeHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthAuthorization>(new CommandDefinition(SelectRequestByCode, new { codeHash }, cancellationToken: ct));
    }

    private const string BurnCode = "UPDATE oauth_authorization_requests SET consumed_at = now() WHERE id = @requestId AND consumed_at IS NULL";

    public async Task<bool> BurnCodeAsync(Guid requestId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(BurnCode, new { requestId }, cancellationToken: ct)) > 0;
    }

    private const string DeleteOldRequests = "DELETE FROM oauth_authorization_requests WHERE created_at < @createdBefore";

    public async Task<int> DeleteRequestsCreatedBeforeAsync(DateTimeOffset createdBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteOldRequests, new { createdBefore }, cancellationToken: ct));
    }

    // The owner filter is here; the statement below revokes only the ids this select returned.
    // ponytail: two first connects of one app at the same instant can both stay live (as on legacy); serialise on the user row, as SessionTokenRepository.LockUser does, if that ever shows up.
    private const string SelectLiveGrantsOfClient = """
        SELECT id, redirect_uri FROM oauth_grants
        WHERE user_id = @userId AND client_name = @clientName AND revoked_at IS NULL
        """;

    // One statement: the replaced grants are revoked exactly when the new one is stored.
    private const string ReplaceGrants = """
        WITH revoked AS (
            UPDATE oauth_grants SET revoked_at = now() WHERE id = ANY(@ids))
        INSERT INTO oauth_grants (id, user_id, client_id, client_name, redirect_uri, resource, scope, access_token_hash, access_token_expires_at, refresh_token_hash, refresh_token_expires_at, created_at)
        VALUES (@Id, @UserId, @ClientId, @ClientName, @RedirectUri, @Resource, @Scope, @AccessTokenHash, @AccessTokenExpiresAt, @RefreshTokenHash, @RefreshTokenExpiresAt, now())
        """;

    // The user's row FOR SHARE until the grant is stored: a reset committing meanwhile is seen, one
    // after it revokes the grant. The approval time is not stored; the request's creation precedes it,
    // so a consent requested before the last reset is refused (the client asks again).
    private const string LockConsentingUser = """
        SELECT EXISTS (
            SELECT FROM users u JOIN oauth_authorization_requests r ON r.user_id = u.id
            WHERE u.id = @userId AND r.id = @requestId
              AND (u.credentials_reset_at IS NULL OR u.credentials_reset_at <= r.created_at)
            FOR SHARE OF u)
        """;

    public async Task<bool> ConnectAsync(Guid userId, Guid requestId, OAuthTokenGrant grant, CancellationToken ct)
    {
        // The host is compared as the consent screen shows it (OAuth.DisplayHost), which SQL cannot reproduce.
        var host = OAuth.DisplayHost(grant.RedirectUri);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        if (!await conn.ExecuteScalarAsync<bool>(new CommandDefinition(LockConsentingUser, new { userId, requestId }, tx, cancellationToken: ct)))
            return false;
        var live = await conn.QueryAsync<(Guid Id, string RedirectUri)>(
            new CommandDefinition(SelectLiveGrantsOfClient, new { userId, grant.ClientName }, tx, cancellationToken: ct));
        var args = new DynamicParameters(grant);
        args.Add("UserId", userId);
        args.Add("ids", live.Where(g => OAuth.DisplayHost(g.RedirectUri) == host).Select(g => g.Id).ToArray());
        await conn.ExecuteAsync(new CommandDefinition(ReplaceGrants, args, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return true;
    }

    private const string SelectByRefreshToken = $"SELECT {GrantColumns} FROM oauth_grants WHERE refresh_token_hash = @refreshTokenHash AND revoked_at IS NULL";

    public async Task<OAuthTokenGrant?> GetByRefreshTokenAsync(string refreshTokenHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthTokenGrant>(new CommandDefinition(SelectByRefreshToken, new { refreshTokenHash }, cancellationToken: ct));
    }

    // ponytail: remembers one generation back (previous_refresh_token_hash); an older spent token is refused but not treated as reuse.
    private const string RevokeOnReuse = """
        UPDATE oauth_grants SET revoked_at = now()
        WHERE previous_refresh_token_hash = @refreshTokenHash AND revoked_at IS NULL
        """;

    public async Task<int> RevokeOnRefreshReuseAsync(string refreshTokenHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RevokeOnReuse, new { refreshTokenHash }, cancellationToken: ct));
    }

    private const string RotateGrant = """
        UPDATE oauth_grants SET
            access_token_hash = @accessTokenHash,
            access_token_expires_at = @accessTokenExpiresAt,
            previous_refresh_token_hash = refresh_token_hash,
            refresh_token_hash = @refreshTokenHash,
            refresh_token_expires_at = @refreshTokenExpiresAt,
            last_used_at = now()
        WHERE id = @grantId AND refresh_token_hash = @oldRefreshTokenHash AND revoked_at IS NULL
        """;

    public async Task<bool> RotateAsync(
        Guid grantId, string oldRefreshTokenHash,
        string accessTokenHash, DateTimeOffset accessTokenExpiresAt,
        string refreshTokenHash, DateTimeOffset refreshTokenExpiresAt,
        CancellationToken ct)
    {
        var args = new { grantId, oldRefreshTokenHash, accessTokenHash, accessTokenExpiresAt, refreshTokenHash, refreshTokenExpiresAt };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RotateGrant, args, cancellationToken: ct)) > 0;
    }

    private const string RevokeByToken = """
        UPDATE oauth_grants SET revoked_at = now()
        WHERE (access_token_hash = @tokenHash OR refresh_token_hash = @tokenHash) AND revoked_at IS NULL
        """;

    public async Task<int> RevokeByTokenAsync(string tokenHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RevokeByToken, new { tokenHash }, cancellationToken: ct));
    }

    private const string SelectByAccessToken = $"""
        SELECT {GrantColumns} FROM oauth_grants
        WHERE access_token_hash = @accessTokenHash AND revoked_at IS NULL AND access_token_expires_at > @now AND resource = @resource
        """;

    public async Task<OAuthTokenGrant?> GetByAccessTokenAsync(string accessTokenHash, string resource, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<OAuthTokenGrant>(new CommandDefinition(
            SelectByAccessToken, new { accessTokenHash, resource, now }, cancellationToken: ct));
    }

    private const string TouchGrant = "UPDATE oauth_grants SET last_used_at = now() WHERE id = @grantId";

    public async Task TouchAsync(Guid grantId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(TouchGrant, new { grantId }, cancellationToken: ct));
    }

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
    private const string RevokeGrantOfUser = "UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = @userId AND id = @grantId";

    public async Task<bool> RevokeAsync(Guid userId, Guid grantId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(RevokeGrantOfUser, new { userId, grantId }, cancellationToken: ct)) > 0;
    }

    private const string DeleteDeadGrants = "DELETE FROM oauth_grants WHERE revoked_at < @before OR refresh_token_expires_at < @before";

    public async Task<int> DeleteDeadGrantsAsync(DateTimeOffset before, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteDeadGrants, new { before }, cancellationToken: ct));
    }
}
