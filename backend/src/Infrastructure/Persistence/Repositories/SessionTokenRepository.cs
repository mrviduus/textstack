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

    // Selected from users, so a user gone is no row rather than an FK error. Its FK check takes only
    // KEY SHARE: it does not queue behind updates of the user row.
    private const string InsertSession = $"""
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        SELECT gen_random_uuid(), id, @tokenHash, @expiresAt, now() FROM users WHERE id = @userId
        RETURNING {SessionColumns}
        """;

    // A password sign-in: FOR SHARE conflicts with a reset's lock on the user (LockResetOwner), so a
    // reset holding it makes this wait, and READ COMMITTED re-checks password_hash on the row the
    // reset committed: a changed password inserts nothing. A reset that comes second deletes this session.
    private const string InsertSessionIfPasswordUnchanged = $"""
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        SELECT gen_random_uuid(), id, @tokenHash, @expiresAt, now() FROM users
        WHERE id = @userId AND password_hash = @verifiedPasswordHash
        FOR SHARE
        RETURNING {SessionColumns}
        """;

    public async Task<SessionToken?> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(
            verifiedPasswordHash is null ? InsertSession : InsertSessionIfPasswordUnchanged,
            new { userId, tokenHash, expiresAt, verifiedPasswordHash }, cancellationToken: ct));
    }

    private const string SelectLiveSession = $"SELECT {SessionColumns} FROM user_refresh_tokens WHERE token_hash = @tokenHash AND expires_at > @now";

    public async Task<SessionToken?> GetLiveAsync(string tokenHash, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(SelectLiveSession, new { tokenHash, now }, cancellationToken: ct));
    }

    // Rotation and password reset both take the user's row first, so a reset either runs before a
    // rotation (which then finds its token gone) or after it (and sees the successor to delete):
    // without it, a successor committed during a reset survived it. NO KEY UPDATE: rows that only
    // reference the user (their FK checks take KEY SHARE) are not held up.
    private const string LockUser = "SELECT FROM users WHERE id = @userId FOR NO KEY UPDATE";

    // The spent row stays, dead (expired at @now), so the previous_token_hash chain can be walked
    // back to its first session (the absolute cap) and forward from a replayed token (RevokeFamily).
    // Of two rotations of one token, the second waits for the first and then finds a successor:
    // nothing to spend. An expired token, or one whose chain began before @familyNotBefore, is not spent.
    private const string RotateSession = $"""
        WITH RECURSIVE chain AS (
            SELECT token_hash, previous_token_hash, created_at FROM user_refresh_tokens
            WHERE user_id = @userId AND token_hash = @oldTokenHash
            UNION
            SELECT p.token_hash, p.previous_token_hash, p.created_at FROM user_refresh_tokens p
            JOIN chain c ON p.token_hash = c.previous_token_hash
            WHERE p.user_id = @userId),
        spent AS (
            UPDATE user_refresh_tokens SET expires_at = @now
            WHERE user_id = @userId AND token_hash = @oldTokenHash AND expires_at > @now
              AND NOT EXISTS (SELECT FROM user_refresh_tokens WHERE previous_token_hash = @oldTokenHash)
              AND (SELECT min(created_at) FROM chain) >= @familyNotBefore
            RETURNING token_hash)
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at, previous_token_hash)
        SELECT gen_random_uuid(), @userId, @newTokenHash, @expiresAt, now(), token_hash FROM spent
        RETURNING {SessionColumns}
        """;

    public async Task<SessionToken?> RotateAsync(
        Guid userId, string oldTokenHash, string newTokenHash, DateTimeOffset expiresAt, DateTimeOffset now, DateTimeOffset familyNotBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(LockUser, new { userId }, tx, cancellationToken: ct));
        var successor = await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(
            RotateSession, new { userId, oldTokenHash, newTokenHash, expiresAt, now, familyNotBefore }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return successor;
    }

    // Everything rotated from the token, however many generations down (the live tail included),
    // unless its own successor is younger than the grace. created_at is stamped by now(), so the
    // grace is measured on the same clock.
    private const string RevokeFamily = """
        WITH RECURSIVE family AS (
            SELECT id, token_hash FROM user_refresh_tokens WHERE previous_token_hash = @tokenHash
            UNION
            SELECT t.id, t.token_hash FROM user_refresh_tokens t JOIN family f ON t.previous_token_hash = f.token_hash)
        DELETE FROM user_refresh_tokens WHERE id IN (SELECT id FROM family)
          AND NOT EXISTS (SELECT FROM user_refresh_tokens WHERE previous_token_hash = @tokenHash AND created_at >= now() - @grace)
        RETURNING user_id
        """;

    public async Task<Guid?> RevokeFamilyAsync(string tokenHash, TimeSpan grace, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<Guid?>(new CommandDefinition(RevokeFamily, new { tokenHash, grace }, cancellationToken: ct)))
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

    // The user lock of LockUser, taken only for a code that can still be redeemed.
    private const string LockResetOwner = """
        SELECT id FROM users
        WHERE id = (SELECT user_id FROM password_reset_tokens WHERE token_hash = @tokenHash AND NOT used AND expires_at > @now)
        FOR NO KEY UPDATE
        """;

    // One statement, so a new password never coexists with the credentials it was meant to cut off.
    // Of two redemptions of one code, the second waits for the first and then finds it used.
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
        expired_logins AS (
            UPDATE device_authorizations SET status = 'expired' WHERE user_id IN (SELECT user_id FROM spent) AND status = 'approved'),
        revoked_keys AS (
            UPDATE mcp_access_keys SET revoked_at = now() WHERE user_id IN (SELECT user_id FROM spent) AND revoked_at IS NULL),
        revoked_grants AS (
            UPDATE oauth_grants SET revoked_at = now() WHERE user_id IN (SELECT user_id FROM spent) AND revoked_at IS NULL)
        SELECT user_id FROM spent
        """;

    public async Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        // The lock first (as RotateAsync), then the redemption in a statement of its own, whose
        // snapshot is taken after the wait and so sees any session committed meanwhile.
        if (await conn.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(LockResetOwner, new { tokenHash, now }, tx, cancellationToken: ct)) is null)
            return null;
        var reset = await conn.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(
            RedeemPasswordReset, new { tokenHash, passwordHash, now }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return reset;
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
