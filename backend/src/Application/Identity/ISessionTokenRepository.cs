using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// V2 sessions and password resets (tables <c>user_refresh_tokens</c>, <c>password_reset_tokens</c>):
/// readers' and admins' sessions alike. Only hashes are stored; a token is found by its hash, which is
/// the credential, so lookups by hash are not scoped to a user. The <c>DeleteExpired…</c> sweeps are
/// cross-user system operations.
/// </summary>
public interface ISessionTokenRepository
{
    /// <summary>Stores a new session of the user and returns it.</summary>
    Task<SessionToken> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>The session with this hash that has not expired by <paramref name="now"/>; null when none.</summary>
    Task<SessionToken?> GetLiveAsync(string tokenHash, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Spends the user's session <paramref name="oldTokenHash"/> and issues its successor, which records
    /// the spent hash. Null when the old one is already gone: a concurrent rotation won, nothing changed.
    /// </summary>
    Task<SessionToken?> RotateAsync(
        Guid userId, string oldTokenHash, string newTokenHash, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>
    /// Reuse detection (RFC 9700 §4.14.2): <paramref name="tokenHash"/> was already rotated away, so
    /// the sessions rotated from it, created before <paramref name="createdBefore"/> (the caller's grace
    /// for a client retrying its own rotation), are revoked. Returns their user; null when none.
    /// </summary>
    Task<Guid?> RevokeSuccessorsOfAsync(string tokenHash, DateTimeOffset createdBefore, CancellationToken ct);

    /// <summary>Signs the session out. False when there is no such session.</summary>
    Task<bool> RevokeAsync(string tokenHash, CancellationToken ct);

    /// <summary>Stores a reset code for the user and returns it.</summary>
    Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>
    /// Spends an unused, unexpired reset code and, in the same statement, sets the user's password and
    /// signs every credential out: sessions deleted, MCP keys and OAuth grants revoked. Returns the
    /// user; null when the code is unknown, used or expired (nothing changed).
    /// </summary>
    Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct);

    /// <summary>Deletes sessions that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct);

    /// <summary>Deletes reset codes that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}
