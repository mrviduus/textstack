using Application.AdminAuth;
using Application.AdminSettings;
using Application.Auth;
using Application.Ops;
using Domain.Enums;
using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// <see cref="IAdminAuthService"/> on <c>textstack_v2</c> (M2.5b): an admin is an account with
/// <c>role = 'admin'</c> (<see cref="AdminRole.Admin"/>; V2 has no editor or moderator, ADR-031
/// decided 7), its sessions in <c>user_refresh_tokens</c> with everyone's, its token lifetimes the
/// admin panel's settings. Only a password sign-in here starts an admin session
/// (<see cref="SessionKind.Admin"/>): a reader session of the same account (a device login an admin
/// approved, say) never refreshes into one.
/// Registered nowhere until M5.1, like <see cref="V2AuthService"/>.
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
        // Null: a reset changed the password since it was checked.
        return await sessions.IssueAsync(admin.Id, hash, await RefreshExpiresAtAsync(ct), verified, SessionKind.Admin, ct) is null
            ? null
            : await ResultAsync(admin, raw, ct);
    }

    public async Task<AdminAuthResult?> RefreshTokenAsync(string refreshToken, CancellationToken ct)
    {
        var (raw, hash) = JwtTokens.NewOpaqueToken();
        var expiresAt = await RefreshExpiresAtAsync(ct);
        var refreshed = await sessions.RefreshAsync(
            DeviceCodes.HashToken(refreshToken), hash, SessionKind.Admin, _ => expiresAt, clock.GetUtcNow(), ct);
        return refreshed is { Outcome: SessionRefreshOutcome.Rotated, User: { } admin } ? await ResultAsync(admin, raw, ct) : null;
    }

    public Task<bool> LogoutAsync(string refreshToken, CancellationToken ct) =>
        sessions.RevokeAsync(DeviceCodes.HashToken(refreshToken), SessionKind.Admin, ct);

    public async Task<AdminUserDto?> GetAdminByIdAsync(Guid adminId, CancellationToken ct) =>
        await users.GetAsync(adminId, ct) is { Role: UserAccount.AdminRole } admin ? ToDto(admin) : null;

    public (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken) => tokens.ValidateAdminAccessToken(accessToken);

    // ponytail: read on every call (legacy caches 5 min); admin sign-ins are rare.
    public async Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default) =>
        AdminSettingsService.ParseMinutes(await settings.GetAsync(AdminSettingsService.AccessTokenExpiryKey, ct));

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default) =>
        AdminSettingsService.ParseDays(await settings.GetAsync(AdminSettingsService.RefreshTokenExpiryKey, ct));

    private async Task<DateTimeOffset> RefreshExpiresAtAsync(CancellationToken ct) =>
        clock.GetUtcNow().AddDays(await GetRefreshTokenExpiryDaysAsync(ct));

    private async Task<AdminAuthResult> ResultAsync(UserAccount admin, string refreshToken, CancellationToken ct) => new(
        ToDto(admin),
        tokens.MintAdminAccessToken(admin.Id, admin.Email, AdminRole.Admin, await GetAccessTokenExpiryMinutesAsync(ct)),
        refreshToken);

    private static AdminUserDto ToDto(UserAccount admin) => new(admin.Id, admin.Email, AdminRole.Admin, admin.CreatedAt);
}
