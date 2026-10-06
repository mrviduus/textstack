using System.Diagnostics;
using System.Text.RegularExpressions;
using Sentry;

namespace Api.Middleware;

/// <summary>
/// Makes the calling mobile build visible: <c>X-App-Version</c> / <c>X-App-Build</c> go onto the
/// request's log scope, its trace span and its Sentry scope (both keys are on the
/// <c>SentryScrubber</c> tag allowlist). Without it the server cannot tell which app version broke —
/// review item #23. Web sends neither header, so for it this is one header lookup and nothing else.
///
/// <para>Records only; it never blocks. The minimum build is advisory, served by
/// <c>GET /app/config</c> and enforced by the app — a misconfigured minimum enforced here would
/// lock every reader out.</para>
/// </summary>
public class AppVersionMiddleware(RequestDelegate next, ILogger<AppVersionMiddleware> logger)
{
    public const string VersionHeader = "X-App-Version";
    public const string BuildHeader = "X-App-Build";
    public const string VersionTag = "app.version";
    public const string BuildTag = "app.build";

    // Untrusted input headed for logs and a third-party tag: version-shaped or nothing.
    private static readonly Regex Safe = new("^[0-9A-Za-z.+-]{1,32}$", RegexOptions.Compiled);

    /// <summary>The header's value when it looks like a version; null when absent or not.</summary>
    public static string? Read(HttpRequest request, string header)
    {
        var value = request.Headers[header].ToString();
        return Safe.IsMatch(value) ? value : null;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var version = Read(context.Request, VersionHeader);
        var build = Read(context.Request, BuildHeader);
        if (version is null && build is null)
        {
            await next(context);
            return;
        }

        Activity.Current?.SetTag(VersionTag, version);
        Activity.Current?.SetTag(BuildTag, build);
        SentrySdk.ConfigureScope(scope =>
        {
            if (version is not null) scope.SetTag(VersionTag, version);
            if (build is not null) scope.SetTag(BuildTag, build);
        });

        using (logger.BeginScope(new Dictionary<string, object?> { ["AppVersion"] = version, ["AppBuild"] = build }))
        {
            await next(context);
        }
    }
}
