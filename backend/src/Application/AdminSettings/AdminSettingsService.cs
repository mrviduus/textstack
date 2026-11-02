using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Application.AdminSettings;

public class AdminSettingsService
{
    private readonly IAppDbContext _db;
    private readonly IMemoryCache _cache;

    internal const string AccessTokenExpiryKey = "session.accessTokenExpiryMinutes";
    internal const string RefreshTokenExpiryKey = "session.refreshTokenExpiryDays";
    private const int DefaultAccessTokenExpiryMinutes = 15;
    // Admin sessions: shorter than user (30d) — elevated privileges, tighter blast radius on stolen cookies.
    private const int DefaultRefreshTokenExpiryDays = 7;
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);

    /// <summary>The stored admin access-token lifetime (<see cref="AccessTokenExpiryKey"/>), else the default; legacy and V2 read it alike.</summary>
    public static int ParseMinutes(string? value) => int.TryParse(value, out var minutes) ? minutes : DefaultAccessTokenExpiryMinutes;

    /// <summary>The stored admin refresh-token lifetime (<see cref="RefreshTokenExpiryKey"/>), else the default.</summary>
    public static int ParseDays(string? value) => int.TryParse(value, out var days) ? days : DefaultRefreshTokenExpiryDays;

    public AdminSettingsService(IAppDbContext db, IMemoryCache cache)
    {
        _db = db;
        _cache = cache;
    }

    public async Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default)
    {
        var cacheKey = $"admin_settings:{AccessTokenExpiryKey}";
        if (_cache.TryGetValue(cacheKey, out int cachedValue))
            return cachedValue;

        var setting = await _db.AdminSettings.FirstOrDefaultAsync(s => s.Key == AccessTokenExpiryKey, ct);
        var value = ParseMinutes(setting?.Value);

        _cache.Set(cacheKey, value, CacheDuration);
        return value;
    }

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default)
    {
        var cacheKey = $"admin_settings:{RefreshTokenExpiryKey}";
        if (_cache.TryGetValue(cacheKey, out int cachedValue))
            return cachedValue;

        var setting = await _db.AdminSettings.FirstOrDefaultAsync(s => s.Key == RefreshTokenExpiryKey, ct);
        var value = ParseDays(setting?.Value);

        _cache.Set(cacheKey, value, CacheDuration);
        return value;
    }

    public async Task SetAccessTokenExpiryMinutesAsync(int minutes, CancellationToken ct = default)
    {
        await SetSettingAsync(AccessTokenExpiryKey, minutes.ToString(), ct);
        _cache.Remove($"admin_settings:{AccessTokenExpiryKey}");
    }

    public async Task SetRefreshTokenExpiryDaysAsync(int days, CancellationToken ct = default)
    {
        await SetSettingAsync(RefreshTokenExpiryKey, days.ToString(), ct);
        _cache.Remove($"admin_settings:{RefreshTokenExpiryKey}");
    }

    public async Task<(int accessTokenExpiryMinutes, int refreshTokenExpiryDays)> GetSessionSettingsAsync(CancellationToken ct = default)
    {
        var access = await GetAccessTokenExpiryMinutesAsync(ct);
        var refresh = await GetRefreshTokenExpiryDaysAsync(ct);
        return (access, refresh);
    }

    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        var cacheKey = $"admin_settings:{key}";
        if (_cache.TryGetValue(cacheKey, out string? cached))
            return cached;

        var setting = await _db.AdminSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        var value = setting?.Value;
        _cache.Set(cacheKey, value, CacheDuration);
        return value;
    }

    public async Task<string> GetAsync(string key, string defaultValue, CancellationToken ct = default)
    {
        return await GetAsync(key, ct) ?? defaultValue;
    }

    public async Task<int> GetIntAsync(string key, int defaultValue, CancellationToken ct = default)
    {
        var raw = await GetAsync(key, ct);
        return raw != null && int.TryParse(raw, out var parsed) ? parsed : defaultValue;
    }

    public async Task<bool> GetBoolAsync(string key, bool defaultValue, CancellationToken ct = default)
    {
        var raw = await GetAsync(key, ct);
        return raw != null && bool.TryParse(raw, out var parsed) ? parsed : defaultValue;
    }

    public async Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        await SetSettingAsync(key, value, ct);
        _cache.Remove($"admin_settings:{key}");
    }

    private async Task SetSettingAsync(string key, string value, CancellationToken ct)
    {
        var setting = await _db.AdminSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (setting == null)
        {
            setting = new Domain.Entities.AdminSettings
            {
                Key = key,
                Value = value,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            _db.AdminSettings.Add(setting);
        }
        else
        {
            setting.Value = value;
            setting.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await _db.SaveChangesAsync(ct);
    }
}
