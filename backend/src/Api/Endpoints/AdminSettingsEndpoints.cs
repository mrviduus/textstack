using Application.AdminSettings;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AdminSettingsEndpoints
{
    public static void MapAdminSettingsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/settings").WithTags("Admin Settings");

        group.MapGet("/session", GetSessionSettings)
            .WithName("GetSessionSettings");

        group.MapPut("/session", UpdateSessionSettings)
            .WithName("UpdateSessionSettings");
    }

    private static async Task<IResult> GetSessionSettings(
        AdminSettingsService settingsService,
        CancellationToken ct)
    {
        var (accessMinutes, refreshDays) = await settingsService.GetSessionSettingsAsync(ct);
        return Results.Ok(new SessionSettingsResponse(accessMinutes, refreshDays));
    }

    private static async Task<IResult> UpdateSessionSettings(
        AdminSettingsService settingsService,
        [FromBody] UpdateSessionSettingsRequest req,
        CancellationToken ct)
    {
        if (req.AccessTokenExpiryMinutes.HasValue)
        {
            if (req.AccessTokenExpiryMinutes < 5 || req.AccessTokenExpiryMinutes > 1440)
                return Results.BadRequest(new { error = "accessTokenExpiryMinutes must be between 5 and 1440" });
            await settingsService.SetAccessTokenExpiryMinutesAsync(req.AccessTokenExpiryMinutes.Value, ct);
        }

        if (req.RefreshTokenExpiryDays.HasValue)
        {
            if (req.RefreshTokenExpiryDays < 1 || req.RefreshTokenExpiryDays > 365)
                return Results.BadRequest(new { error = "refreshTokenExpiryDays must be between 1 and 365" });
            await settingsService.SetRefreshTokenExpiryDaysAsync(req.RefreshTokenExpiryDays.Value, ct);
        }

        var (accessMinutes, refreshDays) = await settingsService.GetSessionSettingsAsync(ct);
        return Results.Ok(new SessionSettingsResponse(accessMinutes, refreshDays));
    }
}

public record SessionSettingsResponse(int AccessTokenExpiryMinutes, int RefreshTokenExpiryDays);
public record UpdateSessionSettingsRequest(int? AccessTokenExpiryMinutes, int? RefreshTokenExpiryDays);
