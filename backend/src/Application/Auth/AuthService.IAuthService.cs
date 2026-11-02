using Domain.Entities;
using Domain.Identity;

namespace Application.Auth;

/// <summary>
/// <see cref="IAuthService"/> on the legacy database: each member is the public method of the same
/// name, its EF <see cref="User"/> mapped to a <see cref="UserAccount"/> and its null to the status the
/// endpoint answers today. Members whose signature already matches implement the interface as they are.
/// </summary>
public partial class AuthService : IAuthService
{
    async Task<AuthResult> IAuthService.TestLoginAsync(string email, CancellationToken ct) =>
        Ok(await TestLoginAsync(email, ct));

    async Task<AuthResult> IAuthService.LoginWithGoogleAsync(string googleIdToken, CancellationToken ct) =>
        Result(await LoginWithGoogleAsync(googleIdToken, ct), AuthStatus.InvalidToken);

    async Task<AuthResult> IAuthService.LoginWithAppleAsync(string identityToken, string? fullName, string? email, CancellationToken ct) =>
        Result(await LoginWithAppleAsync(identityToken, fullName, email, ct), AuthStatus.InvalidToken);

    async Task<AuthResult> IAuthService.CreateGuestSessionAsync(CancellationToken ct) =>
        Ok(await CreateGuestSessionAsync(ct));

    async Task<AuthResult> IAuthService.IssueSessionAsync(UserAccount user, CancellationToken ct)
    {
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct, isGuest: user.IsGuest);
        return AuthResult.Ok(user, _tokens.MintAccessToken(user.Id, user.Email, user.Name, user.IsGuest), refreshToken);
    }

    // A legacy merge keeps every id, so it maps none, and it does not tell a no-op from a move.
    async Task<AccountMerge?> IAuthService.MergeGuestAsync(Guid guestUserId, Guid realUserId, string method, CancellationToken ct) =>
        await MergeGuestAsync(guestUserId, realUserId, method, ct) ? AccountMerge.Empty(AccountMergeOutcome.Merged) : null;

    async Task<AuthResult> IAuthService.RefreshTokenAsync(string refreshToken, CancellationToken ct) =>
        Result(await RefreshTokenAsync(refreshToken, ct), AuthStatus.InvalidToken);

    async Task<UserAccount?> IAuthService.GetUserByIdAsync(Guid userId, CancellationToken ct) =>
        await GetUserByIdAsync(userId, ct) is { } user ? ToAccount(user) : null;

    async Task<AuthResult> IAuthService.RegisterWithEmailAsync(
        string email, string password, string? name, Guid? guestUserId, CancellationToken ct)
    {
        // Register's own null folds both answers into one; asked after, so a lost race is EmailTaken too.
        var registered = await RegisterWithEmailAsync(email, password, name, guestUserId, ct);
        if (registered is null && await EmailExistsAsync(email, ct))
            return AuthResult.Failed(AuthStatus.EmailTaken);
        return Result(registered, AuthStatus.InvalidInput);
    }

    async Task<AuthResult> IAuthService.LoginWithEmailAsync(string email, string password, CancellationToken ct) =>
        Result(await LoginWithEmailAsync(email, password, ct), AuthStatus.InvalidCredentials);

    async Task<DeviceRedeemResult<UserAccount>> IAuthService.RedeemDeviceCodeAsync(string deviceCode, CancellationToken ct)
    {
        var redeemed = await RedeemDeviceCodeAsync(deviceCode, ct);
        return new(redeemed.Status, redeemed.User is null ? null : ToAccount(redeemed.User), redeemed.AccessToken, redeemed.RefreshToken);
    }

    private static AuthResult Ok((User user, string accessToken, string refreshToken) session) =>
        AuthResult.Ok(ToAccount(session.user), session.accessToken, session.refreshToken);

    private static AuthResult Result((User user, string accessToken, string refreshToken)? session, AuthStatus failure) =>
        session is { } s ? Ok(s) : AuthResult.Failed(failure);

    /// <summary>The legacy user as a V2 account; legacy readers are never admins (admins are their own table).</summary>
    public static UserAccount ToAccount(User user) => new()
    {
        Id = user.Id,
        Email = user.Email,
        GoogleSubject = user.GoogleSubject,
        AppleSubject = user.AppleSubject,
        PasswordHash = user.PasswordHash,
        Name = user.Name,
        Picture = user.Picture,
        IsGuest = user.IsGuest,
        LastActiveAt = user.LastActiveAt,
        NativeLanguage = user.NativeLanguage,
        StorageUsedBytes = user.StorageUsedBytes,
        StorageLimitOverrideBytes = user.StorageLimitOverrideBytes,
        Tier = user.Tier.ToString(),
        PromotedAt = user.PromotedAt,
        CreatedAt = user.CreatedAt,
    };
}
