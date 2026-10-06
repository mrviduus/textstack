namespace Api.Endpoints;

/// <summary>What the mobile app reads at start. Null minimum = no minimum.</summary>
public record AppConfigResponse(int? MinSupportedBuild);

public static class AppConfigEndpoints
{
    public static void MapAppConfigEndpoints(this WebApplication app)
    {
        app.MapGet("/app/config", GetAppConfig).WithName("GetAppConfig").WithTags("App");
    }

    /// <summary>
    /// <c>Mobile:MinSupportedBuild</c> (env <c>Mobile__MinSupportedBuild</c>): the oldest Android
    /// versionCode allowed to run. A build number, not the version name — every build so far reports
    /// version "1.0.0" (EAS bumps only versionCode), so a name-based minimum would block the newest
    /// build too. Empty, &lt;=0 or garbage = no minimum. Advisory only: the app shows a blocking
    /// "please update" screen below it, the server never refuses a request.
    /// </summary>
    public static IResult GetAppConfig(IConfiguration config) =>
        Results.Ok(new AppConfigResponse(ParseMinBuild(config["Mobile:MinSupportedBuild"])));

    public static int? ParseMinBuild(string? raw) =>
        int.TryParse(raw?.Trim(), out var n) && n > 0 ? n : null;
}
