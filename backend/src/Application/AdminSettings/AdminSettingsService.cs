using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Application.AdminSettings;

public class AdminSettingsService
{
    private readonly IAppDbContext _db;
    private readonly IMemoryCache _cache;

    private const string AccessTokenExpiryKey = "session.accessTokenExpiryMinutes";
    private const string RefreshTokenExpiryKey = "session.refreshTokenExpiryDays";
    private const int DefaultAccessTokenExpiryMinutes = 60;
    private const int DefaultRefreshTokenExpiryDays = 30;
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);

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
        var value = setting != null && int.TryParse(setting.Value, out var parsed) ? parsed : DefaultAccessTokenExpiryMinutes;

        _cache.Set(cacheKey, value, CacheDuration);
        return value;
    }

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default)
    {
        var cacheKey = $"admin_settings:{RefreshTokenExpiryKey}";
        if (_cache.TryGetValue(cacheKey, out int cachedValue))
            return cachedValue;

        var setting = await _db.AdminSettings.FirstOrDefaultAsync(s => s.Key == RefreshTokenExpiryKey, ct);
        var value = setting != null && int.TryParse(setting.Value, out var parsed) ? parsed : DefaultRefreshTokenExpiryDays;

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
