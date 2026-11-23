using Microsoft.Extensions.Configuration;

namespace Api.Extensions;

/// <summary>
/// The public site origin, <c>App:BaseUrl</c> (appsettings.json): the OAuth issuer, the device-flow
/// page, the MCP manifest and the links in emails. The fallback covers hosts built without appsettings.
/// </summary>
public static class PublicSite
{
    public const string DefaultBaseUrl = "https://textstack.app";

    public static string BaseUrl(IConfiguration config) =>
        (config["App:BaseUrl"] is { Length: > 0 } url ? url : DefaultBaseUrl).TrimEnd('/');
}
