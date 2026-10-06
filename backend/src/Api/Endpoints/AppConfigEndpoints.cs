namespace Api.Endpoints;

/// <summary>What the mobile app reads at start. Null minimum = no minimum.</summary>
public record AppConfigResponse(string? MinSupportedVersion);

public static class AppConfigEndpoints
{
    public static void MapAppConfigEndpoints(this WebApplication app)
    {
        app.MapGet("/app/config", GetAppConfig).WithName("GetAppConfig").WithTags("App");
    }

    /// <summary>
    /// <c>Mobile:MinSupportedVersion</c> (env <c>Mobile__MinSupportedVersion</c>). Advisory only: the
    /// app shows a blocking "please update" screen below it, the server never refuses a request.
    /// </summary>
    public static IResult GetAppConfig(IConfiguration config)
    {
        var min = config["Mobile:MinSupportedVersion"]?.Trim();
        return Results.Ok(new AppConfigResponse(string.IsNullOrEmpty(min) ? null : min));
    }
}
