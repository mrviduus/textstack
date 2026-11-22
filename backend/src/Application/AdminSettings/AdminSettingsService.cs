namespace Application.AdminSettings;

/// <summary>The admin session lifetimes stored in <c>admin_settings</c> (<see cref="Identity.AdminAuthService"/> reads them).</summary>
public static class AdminSettingsService
{
    internal const string AccessTokenExpiryKey = "session.accessTokenExpiryMinutes";
    internal const string RefreshTokenExpiryKey = "session.refreshTokenExpiryDays";
    private const int DefaultAccessTokenExpiryMinutes = 15;
    // Admin sessions: shorter than user (30d) — elevated privileges, tighter blast radius on stolen cookies.
    private const int DefaultRefreshTokenExpiryDays = 7;

    /// <summary>The stored admin access-token lifetime (<see cref="AccessTokenExpiryKey"/>), else the default.</summary>
    public static int ParseMinutes(string? value) => int.TryParse(value, out var minutes) ? minutes : DefaultAccessTokenExpiryMinutes;

    /// <summary>The stored admin refresh-token lifetime (<see cref="RefreshTokenExpiryKey"/>), else the default.</summary>
    public static int ParseDays(string? value) => int.TryParse(value, out var days) ? days : DefaultRefreshTokenExpiryDays;
}
