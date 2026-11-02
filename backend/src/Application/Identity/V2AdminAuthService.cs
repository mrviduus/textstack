using Application.AdminAuth;
using Application.AdminSettings;
using Application.Auth;
using Application.Ops;
using Domain.Enums;
using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// <see cref="IAdminAuthService"/> on <c>textstack_v2</c> (M2.5b): an admin is an account with
/// <c>role = 'admin'</c> (<see cref="AdminRole.Admin"/>; V2 has no editor or moderator), its sessions
/// in <c>user_refresh_tokens</c> with everyone's, its token lifetimes the admin panel's settings.
/// Registered nowhere until M5.1, like <see cref="V2AuthService"/>.
/// ponytail: any session of an admin account (a Google sign-in too) refreshes into an admin token; a session kind column if admin sign-in must stay password-only.
/// </summary>
public sealed class V2AdminAuthService(
    IUserRepository users,
    ISessionTokenRepository sessions,
    IAdminSettingsRepository settings,
    JwtTokens tokens,
    TimeProvider clock) : IAdminAuthService
{
    public async Task<AdminAuthResult?> LoginAsync(string email, string password, CancellationToken ct)
    {
        var admin = await users.GetByEmailAsync(email, ct);
        if (admin is not { Role: UserAccount.AdminRole, PasswordHash: { } verified } || !PasswordHashing.Matches(password, verified))
            return null;
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        // Null: a reset changed the password since it was checked (#1092).
        return await sessions.IssueAsync(admin.Id, hash, await RefreshExpiresAtAsync(ct), verified, ct) is null
            ? null
            : await ResultAsync(admin, raw, ct);
    }

    public async Task<AdminAuthResult?> RefreshTokenAsync(string refreshToken, CancellationToken ct)
    {
        var hash = DeviceCodes.HashToken(refreshToken);
        var now = clock.GetUtcNow();
        var session = await sessions.GetLiveAsync(hash, now, ct);
        var admin = session is null ? null : await users.GetAsync(session.UserId, ct);
        if (admin is not { Role: UserAccount.AdminRole })
            return null;
        var (raw, newHash) = JwtTokens.NewOpaqueToken();
        return await sessions.RotateAsync(admin.Id, hash, newHash, await RefreshExpiresAtAsync(ct), now, ct) is null
            ? null
            : await ResultAsync(admin, raw, ct);
    }

    public Task<bool> LogoutAsync(string refreshToken, CancellationToken ct) =>
        sessions.RevokeAsync(DeviceCodes.HashToken(refreshToken), ct);

    public async Task<AdminUserDto?> GetAdminByIdAsync(Guid adminId, CancellationToken ct) =>
        await users.GetAsync(adminId, ct) is { Role: UserAccount.AdminRole } admin ? ToDto(admin) : null;

    public (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken) => tokens.ValidateAdminAccessToken(accessToken);

    // ponytail: read on every call (legacy caches 5 min); admin sign-ins are rare.
    public Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default) =>
        SettingAsync(AdminSettingsService.AccessTokenExpiryKey, AdminSettingsService.DefaultAccessTokenExpiryMinutes, ct);

    public Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default) =>
        SettingAsync(AdminSettingsService.RefreshTokenExpiryKey, AdminSettingsService.DefaultRefreshTokenExpiryDays, ct);

    private async Task<int> SettingAsync(string key, int fallback, CancellationToken ct) =>
        int.TryParse(await settings.GetAsync(key, ct), out var value) ? value : fallback;

    private async Task<DateTimeOffset> RefreshExpiresAtAsync(CancellationToken ct) =>
        clock.GetUtcNow().AddDays(await GetRefreshTokenExpiryDaysAsync(ct));

    private async Task<AdminAuthResult> ResultAsync(UserAccount admin, string refreshToken, CancellationToken ct) => new(
        ToDto(admin),
        tokens.MintAdminAccessToken(admin.Id, admin.Email, AdminRole.Admin, await GetAccessTokenExpiryMinutesAsync(ct)),
        refreshToken);

    private static AdminUserDto ToDto(UserAccount admin) => new(admin.Id, admin.Email, AdminRole.Admin, admin.CreatedAt);
}
