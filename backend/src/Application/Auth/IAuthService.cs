using System.Diagnostics.CodeAnalysis;
using Domain.Identity;

namespace Application.Auth;

/// <summary>
/// A reader's sign-in, as the auth, device and account endpoints use it: legacy <see cref="AuthService"/>
/// and <see cref="Identity.V2AuthService"/> behind one contract, so M5.1's <c>Database:Mode</c> picks
/// one at startup. Outcomes a user can cause are results, never exceptions.
/// </summary>
public interface IAuthService
{
    /// <summary>Signs in (creating if new) the account with this email, no password: test environments only.</summary>
    Task<AuthResult> TestLoginAsync(string email, CancellationToken ct);

    /// <summary>
    /// <see cref="AuthStatus.InvalidToken"/> when Google does not vouch for the token (or names no email);
    /// <see cref="AuthStatus.EmailTaken"/> when another account holds its email: never linked by email.
    /// </summary>
    Task<AuthResult> LoginWithGoogleAsync(string googleIdToken, CancellationToken ct);

    /// <summary><see cref="AuthStatus.InvalidToken"/> when the token is not signed by Apple (or not for this app); <see cref="AuthStatus.EmailTaken"/> as for Google.</summary>
    Task<AuthResult> LoginWithAppleAsync(string identityToken, string? fullName, string? email, CancellationToken ct);

    /// <summary>A new guest (ADR-014: a real session) and its tokens.</summary>
    Task<AuthResult> CreateGuestSessionAsync(CancellationToken ct);

    /// <summary>A fresh token pair for an existing user, a guest keeping the guest refresh window.</summary>
    Task<AuthResult> IssueSessionAsync(UserAccount user, CancellationToken ct);

    /// <summary>
    /// Moves the guest's data to the signed-in account. Null only when the merge was abandoned on a
    /// conflict and nothing moved (the response says <c>merge_conflict</c>; sign-in continues). Otherwise
    /// what happened: V2 maps the ids it replaced, and its <see cref="AccountMergeOutcome.NoGuest"/> and
    /// <see cref="AccountMergeOutcome.Refused"/> are no-ops, as legacy's <c>true</c> is; legacy keeps
    /// every id and reports <see cref="AccountMergeOutcome.Merged"/> with none.
    /// </summary>
    Task<AccountMerge?> MergeGuestAsync(Guid guestUserId, Guid realUserId, string method, CancellationToken ct);

    /// <summary>
    /// Rotates the refresh token. <see cref="AuthStatus.InvalidToken"/> when it is unknown, expired or
    /// lost a concurrent rotation; <see cref="AuthStatus.TokenReused"/> when it was rotated away already,
    /// which also signs its successor out.
    /// </summary>
    Task<AuthResult> RefreshTokenAsync(string refreshToken, CancellationToken ct);

    /// <summary>Signs the session out (server side, sign-out = revoke it). False when there was none.</summary>
    Task<bool> LogoutAsync(string refreshToken, CancellationToken ct);

    Task<UserAccount?> GetUserByIdAsync(Guid userId, CancellationToken ct);

    /// <summary>
    /// <see cref="AuthStatus.InvalidInput"/> for a malformed email or a password outside 8–128;
    /// <see cref="AuthStatus.EmailTaken"/>. With <paramref name="guestUserId"/> a guest, it becomes the account in place.
    /// </summary>
    Task<AuthResult> RegisterWithEmailAsync(string email, string password, string? name, Guid? guestUserId, CancellationToken ct);

    /// <summary><see cref="AuthStatus.InvalidCredentials"/> for an unknown email, no password, or the wrong one (one answer: no enumeration).</summary>
    Task<AuthResult> LoginWithEmailAsync(string email, string password, CancellationToken ct);

    Task<bool> EmailExistsAsync(string email, CancellationToken ct);

    /// <summary>The raw reset code to email; null when no password account has this email (the caller says nothing either way).</summary>
    Task<string?> RequestPasswordResetAsync(string email, CancellationToken ct);

    /// <summary>Sets the password and signs every credential out. False for a bad password or an unknown, used or expired code.</summary>
    Task<bool> ResetPasswordAsync(string token, string newPassword, CancellationToken ct);

    /// <summary>RFC 8628 §3.2: a pending device login.</summary>
    Task<DeviceCodeResult> CreateDeviceAuthorizationAsync(CancellationToken ct);

    Task<DeviceApprovalResult> ApproveDeviceAsync(string userCode, Guid userId, CancellationToken ct);

    Task<DeviceApprovalResult> DenyDeviceAsync(string userCode, CancellationToken ct);

    /// <summary>
    /// RFC 8628 §3.4: the device's poll. Tokens once approved (single use), else
    /// <see cref="AuthStatus.DevicePending"/>, <see cref="AuthStatus.DeviceDenied"/> or
    /// <see cref="AuthStatus.DeviceExpired"/> (also for an unknown or spent code: no enumeration).
    /// </summary>
    Task<AuthResult> RedeemDeviceCodeAsync(string deviceCode, CancellationToken ct);

    /// <summary>The user a reader's access token belongs to; null when it does not validate.</summary>
    Guid? ValidateAccessToken(string accessToken);

    /// <inheritdoc cref="JwtTokens.ValidateAccessToken"/>
    (Guid? UserId, bool IsGuest) ValidateAccessTokenIdentity(string accessToken);
}

/// <summary>What a sign-in came to: <see cref="Ok"/>, or why not.</summary>
public enum AuthStatus
{
    Ok,
    InvalidCredentials,
    InvalidInput,
    EmailTaken,
    InvalidToken,
    TokenReused,
    DevicePending,
    DeviceDenied,
    DeviceExpired,
}

/// <summary>A sign-in's outcome; the user and both tokens are set exactly when <see cref="Succeeded"/>.</summary>
public sealed record AuthResult(AuthStatus Status, UserAccount? User = null, string? AccessToken = null, string? RefreshToken = null)
{
    [MemberNotNullWhen(true, nameof(User), nameof(AccessToken), nameof(RefreshToken))]
    public bool Succeeded => Status == AuthStatus.Ok;

    public static AuthResult Ok(UserAccount user, string accessToken, string refreshToken) => new(AuthStatus.Ok, user, accessToken, refreshToken);

    public static AuthResult Failed(AuthStatus status) => new(status);
}
