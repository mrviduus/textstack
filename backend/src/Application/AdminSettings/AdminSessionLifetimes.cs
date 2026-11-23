namespace Application.AdminSettings;

/// <summary>AdminSettings' public port for the other features (ADR-034 rule 4): the admin session lifetimes.</summary>
public interface IAdminSessionLifetimes
{
    /// <summary>The stored access-token minutes and refresh-token days, else the defaults (<see cref="AdminSettingsService"/>).</summary>
    Task<(int Minutes, int Days)> GetAsync(CancellationToken ct);
}

/// <summary><see cref="IAdminSessionLifetimes"/> over the admin-settings repository; it delegates, it adds no SQL.</summary>
public sealed class AdminSessionLifetimes(IAdminSettingsRepository settings) : IAdminSessionLifetimes
{
    public async Task<(int Minutes, int Days)> GetAsync(CancellationToken ct) =>
        (AdminSettingsService.ParseMinutes(await settings.GetAsync(AdminSettingsService.AccessTokenExpiryKey, ct)),
            AdminSettingsService.ParseDays(await settings.GetAsync(AdminSettingsService.RefreshTokenExpiryKey, ct)));
}
