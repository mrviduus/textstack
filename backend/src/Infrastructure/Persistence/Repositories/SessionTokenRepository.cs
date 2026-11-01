using Application.Identity;
using Dapper;
using Domain.Identity;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ISessionTokenRepository"/> on <c>textstack_v2</c>. A hash is
/// unique per table (<c>ix_user_refresh_tokens_token_hash</c>, <c>ix_password_reset_tokens_token_hash</c>);
/// a spent session is deleted, a spent reset code is marked used.
/// </summary>
public sealed class SessionTokenRepository(V2DataSource dataSource) : ISessionTokenRepository
{
    private const string SessionColumns = "id, user_id, token_hash, previous_token_hash, expires_at, created_at";

    private const string ResetColumns = "id, user_id, token_hash, expires_at, used, created_at";

    private const string InsertSession = $"""
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (gen_random_uuid(), @userId, @tokenHash, @expiresAt, now())
        RETURNING {SessionColumns}
        """;

    public async Task<SessionToken> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<SessionToken>(new CommandDefinition(InsertSession, new { userId, tokenHash, expiresAt }, cancellationToken: ct));
    }

    private const string SelectLiveSession = $"SELECT {SessionColumns} FROM user_refresh_tokens WHERE token_hash = @tokenHash AND expires_at > @now";

    public async Task<SessionToken?> GetLiveAsync(string tokenHash, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(SelectLiveSession, new { tokenHash, now }, cancellationToken: ct));
    }

    // Of two rotations of one token, the second waits on the first's delete and then finds no row:
    // nothing to spend, so no successor.
    private const string RotateSession = $"""
        WITH spent AS (
            DELETE FROM user_refresh_tokens WHERE user_id = @userId AND token_hash = @oldTokenHash
            RETURNING token_hash)
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at, previous_token_hash)
        SELECT gen_random_uuid(), @userId, @newTokenHash, @expiresAt, now(), token_hash FROM spent
        RETURNING {SessionColumns}
        """;

    public async Task<SessionToken?> RotateAsync(
        Guid userId, string oldTokenHash, string newTokenHash, DateTimeOffset expiresAt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(
            RotateSession, new { userId, oldTokenHash, newTokenHash, expiresAt }, cancellationToken: ct));
    }

    // ponytail: remembers one generation back (previous_token_hash); an older spent token is refused but not treated as reuse.
    private const string RevokeSuccessors = """
        DELETE FROM user_refresh_tokens WHERE previous_token_hash = @tokenHash AND created_at < @createdBefore
        RETURNING user_id
        """;

    public async Task<Guid?> RevokeSuccessorsOfAsync(string tokenHash, DateTimeOffset createdBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<Guid?>(new CommandDefinition(RevokeSuccessors, new { tokenHash, createdBefore }, cancellationToken: ct)))
            .FirstOrDefault();
    }

    private const string DeleteSession = "DELETE FROM user_refresh_tokens WHERE token_hash = @tokenHash";

    public async Task<bool> RevokeAsync(string tokenHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteSession, new { tokenHash }, cancellationToken: ct)) > 0;
    }

    private const string InsertPasswordReset = $"""
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at, used)
        VALUES (gen_random_uuid(), @userId, @tokenHash, @expiresAt, now(), false)
        RETURNING {ResetColumns}
        """;

    public async Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<PasswordReset>(new CommandDefinition(InsertPasswordReset, new { userId, tokenHash, expiresAt }, cancellationToken: ct));
    }

    // One statement, so a new password never coexists with the credentials it was meant to cut off.
    // Of two redemptions of one code, the second waits on the first's update and then finds it used.
    // Keys and grants are revoked, not deleted, as the reader's own revoke does.
    private const string RedeemPasswordReset = """
        WITH spent AS (
            UPDATE password_reset_tokens SET used = true
            WHERE token_hash = @tokenHash AND NOT used AND expires_at > @now
            RETURNING user_id),
        new_password AS (
            UPDATE users SET password_hash = @passwordHash WHERE id IN (SELECT user_id FROM spent)),
        signed_out AS (
            DELETE FROM user_refresh_tokens WHERE user_id IN (SELECT user_id FROM spent)),
        revoked_keys AS (
            UPDATE mcp_access_keys SET revoked_at = @now WHERE user_id IN (SELECT user_id FROM spent) AND revoked_at IS NULL),
        revoked_grants AS (
            UPDATE oauth_grants SET revoked_at = @now WHERE user_id IN (SELECT user_id FROM spent) AND revoked_at IS NULL)
        SELECT user_id FROM spent
        """;

    public async Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(
            RedeemPasswordReset, new { tokenHash, passwordHash, now }, cancellationToken: ct));
    }

    private const string DeleteExpiredSessions = "DELETE FROM user_refresh_tokens WHERE expires_at < @expiredBefore";

    public async Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteExpiredSessions, new { expiredBefore }, cancellationToken: ct));
    }

    private const string DeleteExpiredPasswordResets = "DELETE FROM password_reset_tokens WHERE expires_at < @expiredBefore";

    public async Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteExpiredPasswordResets, new { expiredBefore }, cancellationToken: ct));
    }
}
