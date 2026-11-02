using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// V2 sessions and password resets (tables <c>user_refresh_tokens</c>, <c>password_reset_tokens</c>):
/// the session protocol of readers and admins. Only hashes are stored; a token is found by its hash,
/// which is the credential, so lookups by hash are not scoped to a user. Admin and reader sessions
/// are not interchangeable: a hash is found only under the <see cref="SessionKind"/> it was issued
/// as. The <c>DeleteExpired…</c> sweeps are cross-user system operations.
/// </summary>
public interface ISessionTokenRepository
{
    /// <summary>
    /// A rotated-away refresh token presented again this long after its rotation is a stolen copy and
    /// its family is revoked; inside the window it is two tabs refreshing at once, only refused.
    /// Legacy applies the same grace.
    /// </summary>
    static readonly TimeSpan RefreshReuseGrace = TimeSpan.FromSeconds(30);

    /// <summary>Past this many days since a sign-in's first session, rotation is refused and the user signs in again.</summary>
    const int RefreshAbsoluteDays = 90;

    /// <summary>
    /// Stores a new session of the user, starting a family, and returns it; null when the user is gone.
    /// With <paramref name="verifiedPasswordHash"/> (a password sign-in: the hash the password was
    /// checked against), only while the password still is that hash; with
    /// <paramref name="tokenIssuedAt"/> (a sign-in from an access token: its <c>iat</c>), only if the
    /// password was not reset after it; both when both are given. Every sign-in serializes with a reset:
    /// one committing meanwhile wins.
    /// </summary>
    Task<SessionToken?> IssueAsync(
        Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, DateTimeOffset? tokenIssuedAt, SessionKind kind, CancellationToken ct);

    /// <summary>
    /// Spends the live session <paramref name="oldTokenHash"/> and issues its successor
    /// <paramref name="newTokenHash"/>, live until <paramref name="expiresAt"/> of its user, in one
    /// transaction. <see cref="SessionRefreshOutcome.Rotated"/> with the session and its user;
    /// <see cref="SessionRefreshOutcome.Reused"/> when the token was rotated away already (past
    /// <see cref="RefreshReuseGrace"/>), which revokes its whole sign-in;
    /// <see cref="SessionRefreshOutcome.Invalid"/> otherwise: unknown, expired, another kind, an admin
    /// session of a non-admin, a concurrent rotation or reset won, the sign-in is past
    /// <see cref="RefreshAbsoluteDays"/>. A successor never survives a
    /// <see cref="ResetPasswordAsync"/> that runs at the same time.
    /// </summary>
    Task<SessionRefresh> RefreshAsync(
        string oldTokenHash, string newTokenHash, SessionKind kind, Func<UserAccount, DateTimeOffset> expiresAt, DateTimeOffset now, CancellationToken ct);

    /// <summary>Signs the live session out. False when there is no such live session of that kind (a spent one stays: reuse detection reads it).</summary>
    Task<bool> RevokeAsync(string tokenHash, SessionKind kind, CancellationToken ct);

    /// <summary>Stores a reset code for the user and returns it.</summary>
    Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct);

    /// <summary>
    /// Spends a reset code unused and unexpired at <paramref name="now"/> and, atomically, sets the
    /// user's password and signs every credential out: every session (one a sign-in, a rotation or a
    /// device redemption commits meanwhile too), MCP keys and OAuth grants revoked (an earlier
    /// revocation keeps its time), device logins approved and not yet redeemed
    /// and OAuth consents approved and not yet exchanged expired. Stamps
    /// <see cref="UserAccount.CredentialsResetAt"/>, so access tokens issued before it mint nothing
    /// more. Returns the user; null when the code is unknown, used or expired (nothing changed).
    /// </summary>
    Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Deletes sessions that expired before <paramref name="expiredBefore"/>, rotated-away ones
    /// included, of families none of whose sessions is live at it: a family lives or goes whole, so a
    /// replayed token of a live family is always recognised and the cutoff does not bound reuse
    /// detection. Returns how many.
    /// </summary>
    Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct);

    /// <summary>Deletes reset codes that expired before <paramref name="expiredBefore"/>; returns how many.</summary>
    Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct);
}

/// <summary>Whose session: a reader's (apps, device flow) or the admin panel's.</summary>
public enum SessionKind
{
    Reader,
    Admin,
}

public enum SessionRefreshOutcome
{
    Rotated,
    Reused,
    Invalid,
}

/// <summary>
/// What <see cref="ISessionTokenRepository.RefreshAsync"/> did: the successor and its user when
/// <see cref="SessionRefreshOutcome.Rotated"/>; the user whose sessions were revoked when
/// <see cref="SessionRefreshOutcome.Reused"/>.
/// </summary>
public sealed record SessionRefresh(SessionRefreshOutcome Outcome, SessionToken? Session = null, UserAccount? User = null, Guid? RevokedUserId = null)
{
    public static readonly SessionRefresh Invalid = new(SessionRefreshOutcome.Invalid);

    public static SessionRefresh Reused(Guid userId) => new(SessionRefreshOutcome.Reused, RevokedUserId: userId);
}
