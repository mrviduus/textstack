using Application.Auth;
using Application.Common;
using Domain.Identity;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// <see cref="IAuthService"/> on <c>textstack_v2</c> (M2.5b), over the identity ports and the shared
/// <see cref="JwtTokens"/>. Registered nowhere: M5.1's <c>Database:Mode</c> picks it, and until then
/// only tests build it. Admins sign in through <see cref="V2AdminAuthService"/>: here an admin account
/// signs in only with its password, to a reader session (<see cref="SessionKind.Reader"/>).
/// </summary>
public sealed class V2AuthService(
    IUserRepository users,
    ISessionTokenRepository sessions,
    IDeviceLoginRepository devices,
    IAccountMergeRepository merges,
    JwtTokens tokens,
    TimeProvider clock,
    ILogger<V2AuthService> logger) : IAuthService
{
    public async Task<AuthResult> TestLoginAsync(string email, CancellationToken ct)
    {
        var user = await users.GetByEmailAsync(email, ct)
            ?? await users.CreateAsync(new UserAccount { Id = Guid.NewGuid(), Email = email, Name = email.Split('@')[0] }, ct)
            ?? await users.GetByEmailAsync(email, ct); // a concurrent sign-in made it
        if (user is { Role: UserAccount.AdminRole }) return AuthResult.Failed(AuthStatus.InvalidToken);
        return user is null ? AuthResult.Failed(AuthStatus.EmailTaken) : await IssueAsync(user, null, ct, AuthStatus.InvalidToken);
    }

    public async Task<AuthResult> LoginWithGoogleAsync(string googleIdToken, CancellationToken ct)
    {
        var google = await tokens.VerifyGoogleAsync(googleIdToken);
        if (google?.Email is null) return AuthResult.Failed(AuthStatus.InvalidToken);

        var user = await users.GetByGoogleSubjectAsync(google.Subject, ct);
        if (user is { Role: UserAccount.AdminRole }) return AuthResult.Failed(AuthStatus.InvalidToken);
        if (user is null)
            user = await CreateAsync(
                new UserAccount { Id = Guid.NewGuid(), Email = google.Email, Name = google.Name, Picture = google.Picture, GoogleSubject = google.Subject },
                () => users.GetByGoogleSubjectAsync(google.Subject, ct), ct);
        else if (user.Email != google.Email || user.Name != google.Name || user.Picture != google.Picture)
            // Another account holds the new email: sign in as the account is.
            user = (await users.UpdateProfileAsync(user.Id, google.Email, google.Name, google.Picture, ct)).Account ?? user;

        return user is null ? AuthResult.Failed(AuthStatus.EmailTaken) : await IssueAsync(user, null, ct, AuthStatus.InvalidToken);
    }

    public async Task<AuthResult> LoginWithAppleAsync(string identityToken, string? fullName, string? email, CancellationToken ct)
    {
        var apple = tokens.VerifyApple(identityToken);
        if (apple is null) return AuthResult.Failed(AuthStatus.InvalidToken);

        var user = await users.GetByAppleSubjectAsync(apple.Subject, ct);
        if (user is { Role: UserAccount.AdminRole }) return AuthResult.Failed(AuthStatus.InvalidToken);
        if (user is null)
            user = await CreateAsync(
                new UserAccount { Id = Guid.NewGuid(), Email = email ?? apple.Email ?? $"{apple.Subject}@privaterelay.appleid.com", Name = fullName, AppleSubject = apple.Subject },
                () => users.GetByAppleSubjectAsync(apple.Subject, ct), ct);
        else if (fullName != null && user.Name != fullName)
            user = (await users.UpdateProfileAsync(user.Id, user.Email, fullName, user.Picture, ct)).Account ?? user;

        return user is null ? AuthResult.Failed(AuthStatus.EmailTaken) : await IssueAsync(user, null, ct, AuthStatus.InvalidToken);
    }

    /// <summary>
    /// The new provider account, its subject stored; when something unique is taken, the account a
    /// concurrent sign-in made for the same subject. Null when another account holds the email: never
    /// linked by email (as legacy), or whoever registered an email first would own its later Google or
    /// Apple sign-ins.
    /// </summary>
    private async Task<UserAccount?> CreateAsync(UserAccount account, Func<Task<UserAccount?>> bySubject, CancellationToken ct) =>
        await users.CreateAsync(account, ct) ?? await bySubject();

    public async Task<AuthResult> CreateGuestSessionAsync(CancellationToken ct)
    {
        var guest = await users.CreateAsync(new UserAccount
        {
            Id = Guid.NewGuid(),
            Email = $"guest-{Guid.NewGuid():N}@guest.local",
            Name = "Guest",
            IsGuest = true,
            LastActiveAt = clock.GetUtcNow(),
        }, ct) ?? throw new InvalidOperationException("A new guest's id or email collided.");
        return await IssueAsync(guest, null, ct, AuthStatus.InvalidToken);
    }

    public Task<AuthResult> IssueSessionAsync(UserAccount user, CancellationToken ct) => IssueAsync(user, null, ct, AuthStatus.InvalidToken);

    public async Task<AccountMerge?> MergeGuestAsync(Guid guestUserId, Guid realUserId, string method, CancellationToken ct)
    {
        try
        {
            AccountMerge merged;
            try
            {
                merged = await merges.MergeAsync(guestUserId, realUserId, null, ct);
            }
            // A device of the account wrote the same unique key meanwhile, or two transactions
            // crossed: a fresh snapshot settles both, once.
            catch (Exception e) when (e.IsUniqueViolation() || e.IsTransientConflict())
            {
                merged = await merges.MergeAsync(guestUserId, realUserId, null, ct);
            }
            if (merged.Outcome == AccountMergeOutcome.Merged)
                logger.LogInformation("guest_merged {TargetUserId} {GuestUserId} {Method}", realUserId, guestUserId, method);
            return merged;
        }
        // ADR-014, as legacy: a constraint the merge does not know (or a conflict the retry met again)
        // must not lock the reader out on every retry. The merge rolled back, the guest keeps its rows;
        // sign-in continues and says so.
        catch (Exception e) when (e.IsIntegrityViolation() || e.IsTransientConflict())
        {
            logger.LogError(e, "Guest merge hit a constraint violation and was skipped; sign-in continued. "
                + "Guest {GuestUserId} data is orphaned on the guest row. Real user {RealUserId}", guestUserId, realUserId);
            return null;
        }
    }

    public async Task<AuthResult> RefreshTokenAsync(string refreshToken, CancellationToken ct)
    {
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        var now = clock.GetUtcNow();
        var refreshed = await sessions.RefreshAsync(
            DeviceCodes.HashToken(refreshToken), hash, SessionKind.Reader, user => RefreshExpiresAt(user, now), now, ct);
        if (refreshed.Outcome == SessionRefreshOutcome.Reused)
        {
            logger.LogWarning("Rotated refresh token presented again; revoked its family for user {UserId}", refreshed.RevokedUserId);
            return AuthResult.Failed(AuthStatus.TokenReused);
        }
        return refreshed is { Outcome: SessionRefreshOutcome.Rotated, User: { } user }
            ? AuthResult.Ok(user, MintAccessToken(user), raw)
            : AuthResult.Failed(AuthStatus.InvalidToken);
    }

    public Task<bool> LogoutAsync(string refreshToken, CancellationToken ct) =>
        sessions.RevokeAsync(DeviceCodes.HashToken(refreshToken), SessionKind.Reader, ct);

    public Task<UserAccount?> GetUserByIdAsync(Guid userId, CancellationToken ct) => users.GetAsync(userId, ct);

    public async Task<AuthResult> RegisterWithEmailAsync(string email, string password, string? name, Guid? guestUserId, CancellationToken ct)
    {
        email = Normalize(email);
        if (!System.Net.Mail.MailAddress.TryCreate(email, out _) || password.Length is < 8 or > 128)
            return AuthResult.Failed(AuthStatus.InvalidInput);
        if (await users.GetByEmailAsync(email, ct) is not null)
            return AuthResult.Failed(AuthStatus.EmailTaken);

        var passwordHash = BCrypt.Net.BCrypt.HashPassword(password);
        name = name?.Trim();
        UserAccount? user = null;
        if (guestUserId is { } guestId)
        {
            // In place: the guest keeps its id and everything it owns. Not a guest → a new account.
            var promoted = await users.PromoteGuestAsync(guestId, email, name, passwordHash, ct);
            if (promoted.Outcome == AccountUpdateOutcome.EmailTaken) return AuthResult.Failed(AuthStatus.EmailTaken);
            user = promoted.Account;
            if (user is not null) logger.LogInformation("guest_promoted {UserId}", user.Id);
        }
        user ??= await users.CreateAsync(new UserAccount { Id = Guid.NewGuid(), Email = email, Name = name, PasswordHash = passwordHash }, ct);
        return user is null ? AuthResult.Failed(AuthStatus.EmailTaken) : await IssueAsync(user, passwordHash, ct, AuthStatus.InvalidCredentials);
    }

    public async Task<AuthResult> LoginWithEmailAsync(string email, string password, CancellationToken ct)
    {
        var user = await users.GetByEmailAsync(Normalize(email), ct);
        if (user?.PasswordHash is not { } verified || !PasswordHashing.Matches(password, verified))
            return AuthResult.Failed(AuthStatus.InvalidCredentials);
        // A reset that commits after the check: no session (#1092), the old password is wrong now.
        return await IssueAsync(user, verified, ct, AuthStatus.InvalidCredentials);
    }

    public async Task<bool> EmailExistsAsync(string email, CancellationToken ct) =>
        await users.GetByEmailAsync(Normalize(email), ct) is not null;

    public async Task<string?> RequestPasswordResetAsync(string email, CancellationToken ct)
    {
        var user = await users.GetByEmailAsync(Normalize(email), ct);
        if (user?.PasswordHash is null) return null; // don't reveal whether the email exists
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        await sessions.CreatePasswordResetAsync(user.Id, hash, clock.GetUtcNow().AddHours(1), ct);
        return raw;
    }

    /// <summary>
    /// The new password, every session, MCP key and OAuth grant signed out and approved device logins
    /// expired, in one statement (<see cref="ISessionTokenRepository.ResetPasswordAsync"/>).
    /// ponytail: an access JWT minted before the reset lives out its hour; <c>credentials_reset_at</c> vs its <c>iat</c> is #1092 (migration 0002).
    /// </summary>
    public async Task<bool> ResetPasswordAsync(string token, string newPassword, CancellationToken ct)
    {
        if (newPassword.Length is < 8 or > 128) return false;
        return await sessions.ResetPasswordAsync(
            DeviceCodes.HashToken(token), BCrypt.Net.BCrypt.HashPassword(newPassword), clock.GetUtcNow(), ct) is not null;
    }

    public async Task<DeviceCodeResult> CreateDeviceAuthorizationAsync(CancellationToken ct)
    {
        var deviceCode = DeviceCodes.GenerateSecureToken();
        var now = clock.GetUtcNow();
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var login = new DeviceLogin
            {
                Id = Guid.NewGuid(),
                DeviceCodeHash = DeviceCodes.HashToken(deviceCode),
                UserCode = DeviceCodes.GenerateUserCode(),
                ExpiresAt = now.AddSeconds(DeviceCodes.ExpiresInSeconds),
                IntervalSeconds = DeviceCodes.IntervalSeconds,
            };
            if (await devices.CreateAsync(login, now, ct))
                return new DeviceCodeResult(deviceCode, login.UserCode, DeviceCodes.ExpiresInSeconds, DeviceCodes.IntervalSeconds);
        }
        throw new InvalidOperationException("Could not generate a unique device user_code.");
    }

    public Task<DeviceApprovalResult> ApproveDeviceAsync(string userCode, Guid userId, CancellationToken ct) => DecideAsync(userCode, userId, ct);

    public Task<DeviceApprovalResult> DenyDeviceAsync(string userCode, CancellationToken ct) => DecideAsync(userCode, null, ct);

    private async Task<DeviceApprovalResult> DecideAsync(string userCode, Guid? approvedBy, CancellationToken ct)
    {
        var normalized = DeviceCodes.NormalizeUserCode(userCode);
        if (normalized.Length == 0) return DeviceApprovalResult.NotFound;
        return await devices.DecideAsync(normalized, approvedBy, clock.GetUtcNow(), ct) switch
        {
            null => DeviceApprovalResult.NotFound,
            DeviceLogin.Expired => DeviceApprovalResult.Expired,
            _ => DeviceApprovalResult.Ok,
        };
    }

    public async Task<AuthResult> RedeemDeviceCodeAsync(string deviceCode, CancellationToken ct)
    {
        // Unknown, spent and expired codes answer alike: no enumeration.
        var expired = AuthResult.Failed(AuthStatus.DeviceExpired);
        if (string.IsNullOrEmpty(deviceCode)) return expired;

        var login = await devices.GetByDeviceCodeAsync(DeviceCodes.HashToken(deviceCode), ct);
        var now = clock.GetUtcNow();
        switch (login?.Status)
        {
            case DeviceLogin.Pending when login.ExpiresAt <= now: // every read treats it as expired; nothing to write
                return expired;
            case DeviceLogin.Pending:
                return AuthResult.Failed(AuthStatus.DevicePending);
            case DeviceLogin.Denied:
                return AuthResult.Failed(AuthStatus.DeviceDenied);
            case DeviceLogin.Approved when login.UserId is { } approver:
                // Single use: of two polls one redeems, and the session is stored with the redemption,
                // so a reset can never fall between them. A reset since the approval expired it.
                var user = await users.GetAsync(approver, ct);
                if (user is null) return expired;
                var (raw, hash) = JwtTokens.NewOpaqueToken();
                return await devices.RedeemAsync(login.Id, hash, RefreshExpiresAt(user, now), now, ct)
                    ? AuthResult.Ok(user, MintAccessToken(user), raw)
                    : expired;
            default:
                return expired;
        }
    }

    public Guid? ValidateAccessToken(string accessToken) => tokens.ValidateAccessToken(accessToken).UserId;

    public (Guid? UserId, bool IsGuest) ValidateAccessTokenIdentity(string accessToken) => tokens.ValidateAccessToken(accessToken);

    /// <summary>
    /// A new session and access token for <paramref name="user"/>. <paramref name="refused"/> when no
    /// session was stored: the account is gone, or (with <paramref name="verifiedPasswordHash"/>) its
    /// password changed since it was checked.
    /// </summary>
    private async Task<AuthResult> IssueAsync(UserAccount user, string? verifiedPasswordHash, CancellationToken ct, AuthStatus refused)
    {
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        return await sessions.IssueAsync(user.Id, hash, RefreshExpiresAt(user, clock.GetUtcNow()), verifiedPasswordHash, SessionKind.Reader, ct) is null
            ? AuthResult.Failed(refused)
            : AuthResult.Ok(user, MintAccessToken(user), raw);
    }

    private DateTimeOffset RefreshExpiresAt(UserAccount user, DateTimeOffset now) => now.AddDays(tokens.RefreshTokenDays(user.IsGuest));

    private string MintAccessToken(UserAccount user) => tokens.MintAccessToken(user.Id, user.Email, user.Name, user.IsGuest);

    private static string Normalize(string email) => email.Trim().ToLowerInvariant();
}
