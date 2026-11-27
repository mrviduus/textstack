namespace Application.AdminSettings;

/// <summary>The V2 runtime settings (table <c>admin_settings</c>, set by SQL; no write path): one value per key.</summary>
public interface IAdminSettingsRepository
{
    /// <summary>The value under <paramref name="key"/>; null when unset.</summary>
    Task<string?> GetAsync(string key, CancellationToken ct);
}
