using Application.Identity;
using Dapper;
using Domain.Identity;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ISessionTokenRepository"/> on <c>textstack_v2</c>. A hash is
/// unique per table (<c>ix_user_refresh_tokens_token_hash</c>, <c>ix_password_reset_tokens_token_hash</c>).
/// <list type="bullet">
/// <item>Lock order on the user row, so a password reset either runs before a credential write (which
/// then finds nothing to do) or after it (and sees what to sign out): the reset and a rotation take it
/// <c>FOR NO KEY UPDATE</c>; a password sign-in and a device redemption take it <c>FOR SHARE</c>. Rows
/// that only reference the user (FK checks: <c>KEY SHARE</c>) are not held up.</item>
/// <item>A rotated-away session stays, expired, so its <c>previous_token_hash</c> chain can be walked
/// back to its first session (the absolute lifetime) and forward from a replayed token (its family).
/// <see cref="DeleteExpiredSessionsAsync"/> must not be given a cutoff younger than
/// <see cref="ISessionTokenRepository.RefreshAbsoluteDays"/>, or it cuts those chains short.</item>
/// <item>The kind is part of the stored hash: an admin session's is <c>adm.</c> + its hash, so a hash
/// looked up as the other kind finds nothing.</item>
/// </list>
/// ponytail: migration 0002 (#1092's bundle) gives sessions a <c>kind</c> and a <c>family_started_at</c>/<c>family_id</c>; the prefix, the recursive chain walks and the sweep caveat go with it.
/// </summary>
public sealed class SessionTokenRepository(V2DataSource dataSource) : ISessionTokenRepository
{
    private const string SessionColumns = "id, user_id, token_hash, previous_token_hash, expires_at, created_at";

    private const string ResetColumns = "id, user_id, token_hash, expires_at, used, created_at";

    private const string AdminPrefix = "adm.";

    private static string Stored(string tokenHash, SessionKind kind) => kind == SessionKind.Admin ? AdminPrefix + tokenHash : tokenHash;

    /// <summary>
    /// A new session of <c>users u</c> (<c>@tokenHash</c> as stored, <c>@expiresAt</c>): the caller adds
    /// the WHERE. Selected from users, so a user gone is no row rather than an FK error.
    /// </summary>
    internal const string InsertSessionFromUser = """
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        SELECT gen_random_uuid(), u.id, @tokenHash, @expiresAt, now() FROM users u
        """;

    private const string InsertSession = $"""
        {InsertSessionFromUser} WHERE u.id = @userId
        RETURNING {SessionColumns}
        """;

    // READ COMMITTED re-checks password_hash on the row a reset committed while this waited.
    private const string InsertSessionIfPasswordUnchanged = $"""
        {InsertSessionFromUser} WHERE u.id = @userId AND u.password_hash = @verifiedPasswordHash
        FOR SHARE
        RETURNING {SessionColumns}
        """;

    public async Task<SessionToken?> IssueAsync(
        Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, SessionKind kind, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(
            verifiedPasswordHash is null ? InsertSession : InsertSessionIfPasswordUnchanged,
            new { userId, tokenHash = Stored(tokenHash, kind), expiresAt, verifiedPasswordHash }, cancellationToken: ct));
    }

    private const string LockLiveSessionOwner = $"""
        SELECT {UserRepository.Columns} FROM users
        WHERE id = (SELECT user_id FROM user_refresh_tokens WHERE token_hash = @oldTokenHash AND expires_at > @now)
        FOR NO KEY UPDATE
        """;

    // Of two rotations of one token, the second waits for the first and then finds a successor:
    // nothing to spend. Nor is an expired token, or one whose chain began before @familyNotBefore.
    private const string RotateSession = $"""
        WITH RECURSIVE chain AS (
            SELECT previous_token_hash, created_at FROM user_refresh_tokens
            WHERE user_id = @userId AND token_hash = @oldTokenHash
            UNION ALL
            SELECT p.previous_token_hash, p.created_at FROM user_refresh_tokens p
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

    // Everything rotated from the token, however many generations down, unless its own successor is
    // younger than the grace. created_at is stamped by now(), so the grace is on the same clock.
    private const string RevokeFamily = """
        WITH RECURSIVE family AS (
            SELECT id, token_hash FROM user_refresh_tokens WHERE previous_token_hash = @oldTokenHash
            UNION ALL
            SELECT t.id, t.token_hash FROM user_refresh_tokens t JOIN family f ON t.previous_token_hash = f.token_hash)
        DELETE FROM user_refresh_tokens WHERE id IN (SELECT id FROM family)
          AND NOT EXISTS (SELECT FROM user_refresh_tokens WHERE previous_token_hash = @oldTokenHash AND created_at >= now() - @grace)
        RETURNING user_id
        """;

    public async Task<SessionRefresh> RefreshAsync(
        string oldTokenHash, string newTokenHash, SessionKind kind, Func<UserAccount, DateTimeOffset> expiresAt, DateTimeOffset now, CancellationToken ct)
    {
        var (old, next) = (Stored(oldTokenHash, kind), Stored(newTokenHash, kind));
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var user = await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(
            LockLiveSessionOwner, new { oldTokenHash = old, now }, tx, cancellationToken: ct));
        if (user is null)
        {
            var revoked = (await conn.QueryAsync<Guid>(new CommandDefinition(
                RevokeFamily, new { oldTokenHash = old, grace = ISessionTokenRepository.RefreshReuseGrace }, tx, cancellationToken: ct))).ToList();
            await tx.CommitAsync(ct);
            return revoked.Count > 0 ? SessionRefresh.Reused(revoked[0]) : SessionRefresh.Invalid;
        }
        if (kind == SessionKind.Admin && user.Role != UserAccount.AdminRole)
            return SessionRefresh.Invalid;

        var session = await conn.QuerySingleOrDefaultAsync<SessionToken>(new CommandDefinition(RotateSession, new
        {
            userId = user.Id,
            oldTokenHash = old,
            newTokenHash = next,
            expiresAt = expiresAt(user),
            now,
            familyNotBefore = now.AddDays(-ISessionTokenRepository.RefreshAbsoluteDays),
        }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return session is null ? SessionRefresh.Invalid : new(SessionRefreshOutcome.Rotated, session, user);
    }

    private const string DeleteSession = "DELETE FROM user_refresh_tokens WHERE token_hash = @tokenHash";

    public async Task<bool> RevokeAsync(string tokenHash, SessionKind kind, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteSession, new { tokenHash = Stored(tokenHash, kind) }, cancellationToken: ct)) > 0;
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

    // Taken only for a code that can still be redeemed.
    private const string LockResetOwner = """
        SELECT id FROM users
        WHERE id = (SELECT user_id FROM password_reset_tokens WHERE token_hash = @tokenHash AND NOT used AND expires_at > @now)
        FOR NO KEY UPDATE
        """;

    // One statement, so a new password never coexists with the credentials it was meant to cut off;
    // its snapshot is taken after the lock wait, so it sees what was committed meanwhile. Of two
    // redemptions of one code, the second finds it used. Keys and grants are revoked, not deleted,
    // as the reader's own revoke does.
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
