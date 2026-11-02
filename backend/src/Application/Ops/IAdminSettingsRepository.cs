namespace Application.Ops;

/// <summary>The V2 runtime settings edited from the admin panel (table <c>admin_settings</c>): one value per key.</summary>
public interface IAdminSettingsRepository
{
    /// <summary>The value under <paramref name="key"/>; null when unset.</summary>
    Task<string?> GetAsync(string key, CancellationToken ct);

    /// <summary>Sets the value under <paramref name="key"/>, creating it or replacing what was there.</summary>
    Task SetAsync(string key, string value, CancellationToken ct);
}
