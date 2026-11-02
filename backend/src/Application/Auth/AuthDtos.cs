namespace Application.Auth;

public record GoogleLoginRequest(string IdToken);

public record AppleLoginRequest(string IdentityToken, string? FullName, string? Email);

public record TestLoginRequest(string Email);

public record MobileRefreshRequest(string RefreshToken);

/// <param name="GuestMergeSkipped">
/// Null on every ordinary sign-in. Non-null means the server decided NOT to carry pre-sign-in guest
/// data across and completed the sign-in anyway — see <c>AuthEndpoints.GuestMergeSkipReason</c> for
/// the values. Additive and optional: clients that ignore it behave exactly as before, but a client
/// that reads it can tell the user their offline work did not come with them instead of letting it
/// disappear without a word.
/// </param>
/// <param name="Merge">
/// The guest's V2 ids that the merge replaced (v2-sync-protocol.md "Guest → account merge"). Null
/// unless V2 merged the guest and some id changed; additive, so clients that ignore it are unaffected.
/// </param>
public record AuthResponse(UserDto User, string? GuestMergeSkipped = null, GuestMergeMap? Merge = null);

/// <inheritdoc cref="AuthResponse"/>
public record MobileAuthResponse(
    UserDto User, string AccessToken, string RefreshToken, string? GuestMergeSkipped = null, GuestMergeMap? Merge = null);

/// <summary>Guest id → account id, per kind: only ids that changed.</summary>
public record GuestMergeMap(IReadOnlyDictionary<Guid, Guid> Books, IReadOnlyDictionary<Guid, Guid> Files, IReadOnlyDictionary<Guid, Guid> Words);

public record UserDto(Guid Id, string Email, string? Name, string? Picture, bool IsGuest, DateTimeOffset CreatedAt, string? NativeLanguage);

public record EmailRegisterRequest(string Email, string Password, string? Name);

public record EmailLoginRequest(string Email, string Password);

public record ForgotPasswordRequest(string Email);

public record ResetPasswordRequest(string Token, string Password);
