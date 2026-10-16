namespace Api.Endpoints;

/// <summary>What the mobile app reads at start. Null minimum = no minimum; null latest = no nudge.</summary>
public record AppConfigResponse(int? MinSupportedBuild, int? LatestBuild);

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
    ///
    /// <para><c>Mobile:LatestBuild</c> (env <c>Mobile__LatestBuild</c>): the newest versionCode on the
    /// Play track testers use. Below it (but at or above the minimum) the app shows a dismissible
    /// "new version" bar, because Play updates early-access builds late and an OTA only reaches a
    /// build with the same runtime — an older build is stuck silently. Same parsing rules. Set it
    /// only once the build is fully rolled out on that track: a staged rollout would nudge testers
    /// to an update Play does not yet offer them.</para>
    /// </summary>
    public static IResult GetAppConfig(IConfiguration config) =>
        Results.Ok(new AppConfigResponse(
            ParseMinBuild(config["Mobile:MinSupportedBuild"]),
            ParseMinBuild(config["Mobile:LatestBuild"])));

    public static int? ParseMinBuild(string? raw) =>
        int.TryParse(raw?.Trim(), out var n) && n > 0 ? n : null;
}
