using Application.AdminAuth;
using Application.AdminSettings;
using Application.Auth;
using Application.Ops;
using Domain.Enums;
using Domain.Identity;
using Microsoft.Extensions.Caching.Memory;

namespace Application.Identity;

/// <inheritdoc cref="IAdminAuthService"/>
/// <remarks>
/// On <c>textstack_v2</c> (M2.5b): an admin is an account with <c>role = 'admin'</c>
/// (<see cref="AdminRole.Admin"/>; V2 has no editor or moderator, ADR-031 decided 7). Registered
/// nowhere until M5.1, like <see cref="V2AuthService"/>.
/// </remarks>
public sealed class V2AdminAuthService(
    IUserRepository users,
    ISessionTokenRepository sessions,
    IAdminSettingsRepository settings,
    IMemoryCache cache,
    JwtTokens tokens,
    TimeProvider clock) : IAdminAuthService
{
    private static readonly TimeSpan SettingsCacheDuration = TimeSpan.FromMinutes(5);

    public async Task<AdminAuthResult?> LoginAsync(string email, string password, CancellationToken ct)
    {
        var admin = await users.GetByEmailAsync(email, ct);
        if (admin is not { Role: UserAccount.AdminRole, PasswordHash: { } verified } || !PasswordHashing.Matches(password, verified))
            return null;
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        var (_, days) = await SessionSettingsAsync(ct);
        // Null: a reset changed the password since it was checked.
        return await sessions.IssueAsync(admin.Id, hash, clock.GetUtcNow().AddDays(days), verified, null, SessionKind.Admin, ct) is null
            ? null
            : await ResultAsync(admin, raw, ct);
    }

    public async Task<AdminAuthResult?> RefreshTokenAsync(string refreshToken, CancellationToken ct)
    {
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        var (_, days) = await SessionSettingsAsync(ct);
        var now = clock.GetUtcNow();
        var refreshed = await sessions.RefreshAsync(DeviceCodes.HashToken(refreshToken), hash, SessionKind.Admin, _ => now.AddDays(days), now, ct);
        return refreshed is { Outcome: SessionRefreshOutcome.Rotated, User: { } admin } ? await ResultAsync(admin, raw, ct) : null;
    }

    public Task<bool> LogoutAsync(string refreshToken, CancellationToken ct) =>
        sessions.RevokeAsync(DeviceCodes.HashToken(refreshToken), SessionKind.Admin, ct);

    public async Task<AdminUserDto?> GetAdminByIdAsync(Guid adminId, CancellationToken ct) =>
        await users.GetAsync(adminId, ct) is { Role: UserAccount.AdminRole } admin ? ToDto(admin) : null;

    public (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken) => tokens.ValidateAdminAccessToken(accessToken);

    public async Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default) => (await SessionSettingsAsync(ct)).Minutes;

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default) => (await SessionSettingsAsync(ct)).Days;

    /// <summary>The admin panel's token lifetimes, cached for five minutes as legacy caches them.</summary>
    private async Task<(int Minutes, int Days)> SessionSettingsAsync(CancellationToken ct) =>
        await cache.GetOrCreateAsync("v2-admin-session-settings", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = SettingsCacheDuration;
            return (AdminSettingsService.ParseMinutes(await settings.GetAsync(AdminSettingsService.AccessTokenExpiryKey, ct)),
                AdminSettingsService.ParseDays(await settings.GetAsync(AdminSettingsService.RefreshTokenExpiryKey, ct)));
        });

    private async Task<AdminAuthResult> ResultAsync(UserAccount admin, string refreshToken, CancellationToken ct) => new(
        ToDto(admin),
        tokens.MintAdminAccessToken(admin.Id, admin.Email, AdminRole.Admin, (await SessionSettingsAsync(ct)).Minutes),
        refreshToken);

    private static AdminUserDto ToDto(UserAccount admin) => new(admin.Id, admin.Email, AdminRole.Admin, admin.CreatedAt);
}
