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
    /// <summary>
    /// Stores a new session of the user and returns it. With <paramref name="verifiedPasswordHash"/> (a
    /// password sign-in: the hash the password was checked against), only while the user's password
    /// still is that hash, so a reset committing between the check and this insert wins: null, nothing
    /// stored (#1092). Null too when the user is gone.
    /// </summary>
    Task<SessionToken?> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, CancellationToken ct);

    /// <summary>The session with this hash that has not expired by <paramref name="now"/>; null when none.</summary>
    Task<SessionToken?> GetLiveAsync(string tokenHash, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Spends the user's session <paramref name="oldTokenHash"/>, live at <paramref name="now"/>, and
    /// issues its successor, which records the spent hash; the spent row stays, expired, so the chain
    /// can be walked. Null (nothing changed) when the old one is gone, expired or already rotated (a
    /// concurrent rotation or a password reset won), or when its chain's first session is older than
    /// <paramref name="familyNotBefore"/> (the absolute lifetime). A successor never survives a
    /// <see cref="ResetPasswordAsync"/> that runs at the same time.
    /// </summary>
    Task<SessionToken?> RotateAsync(
        Guid userId, string oldTokenHash, string newTokenHash, DateTimeOffset expiresAt, DateTimeOffset now, DateTimeOffset familyNotBefore, CancellationToken ct);

    /// <summary>
    /// Reuse detection (RFC 9700 §4.14.2): <paramref name="tokenHash"/> was already rotated away, so
    /// every session rotated from it, any generations down, is revoked: unless its own successor is
    /// younger than <paramref name="grace"/> (a client retrying its own rotation). Returns their user;
    /// null when none.
    /// </summary>
    Task<Guid?> RevokeFamilyAsync(string tokenHash, TimeSpan grace, CancellationToken ct);

    /// <summary>Signs the session out. False when there is no such session.</summary>
    Task<bool> RevokeAsync(string tokenHash, CancellationToken ct);

    /// <summary>Stores a reset code for the user and returns it.</summary>
    Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>
    /// Spends a reset code unused and unexpired at <paramref name="now"/> and, atomically, sets the
    /// user's password and signs every credential out: sessions deleted (one a rotation or a password
    /// sign-in commits meanwhile too), MCP keys and OAuth grants revoked (an earlier revocation keeps its
    /// time), device logins approved and not yet redeemed expired.
    /// ponytail: access JWTs minted before the reset live out their hour; <c>users.credentials_reset_at</c> vs <c>iat</c> is #1092 (migration 0002).
    /// Returns the user; null when the code is unknown, used or expired (nothing changed).
    /// </summary>
    Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Deletes sessions that expired before <paramref name="expiredBefore"/>, rotated-away ones
    /// included; returns how many. A cutoff more recent than the absolute lifetime ago shortens the
    /// chains reuse detection and the cap can walk.
    /// </summary>
    Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct);

    /// <summary>Deletes reset codes that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}
