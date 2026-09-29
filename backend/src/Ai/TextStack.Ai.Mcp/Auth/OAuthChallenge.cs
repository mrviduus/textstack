using Microsoft.AspNetCore.Http;

namespace TextStack.Ai.Mcp.Auth;

/// <summary>
/// The resource-server half of MCP OAuth (ADR-017): the http host demands a bearer on all of
/// <c>/mcp</c> and, when there is none, answers <c>401</c> with a <c>WWW-Authenticate</c> pointing at
/// the Protected Resource Metadata (RFC 9728). That 401 is what makes Claude/ChatGPT start the
/// sign-in; a 200 with failing tools never would.
///
/// The host does not validate tokens itself — the API does, audience included. The one exception is
/// an OAuth access token (<c>tso_</c>), whose expiry is asked of the API so that an expired one gets
/// the 401 clients refresh on. Connect keys (<c>tsk_</c>, incl. the <c>/mcp/k/</c> URL rewritten
/// before this runs) and JWTs pass through exactly as before.
/// </summary>
public static class OAuthChallenge
{
    public const string ResourceMetadataPath = "/.well-known/oauth-protected-resource";
    public const string Scope = "library";

    /// <summary>The PRM URL the challenge advertises (path-suffixed form, RFC 9728 §3.1).</summary>
    public static string ResourceMetadataUrl(string publicBaseUrl) => $"{publicBaseUrl}{ResourceMetadataPath}/mcp";

    /// <summary>The Protected Resource Metadata document. The resource is exactly the URL a user pastes.</summary>
    public static object Metadata(string publicBaseUrl) => new Dictionary<string, object>
    {
        ["resource"] = $"{publicBaseUrl}/mcp",
        ["authorization_servers"] = new[] { publicBaseUrl },
        ["scopes_supported"] = new[] { Scope, "offline_access" },
        ["bearer_methods_supported"] = new[] { "header" },
        ["resource_name"] = "TextStack",
    };

    /// <summary>The bearer on this request, or null when there is none worth forwarding.</summary>
    public static string? Bearer(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        var token = header["Bearer ".Length..].Trim();
        return token.Length == 0 ? null : token;
    }

    /// <summary>Writes the 401. <paramref name="error"/> is omitted when no credentials were sent (RFC 6750 §3.1).</summary>
    public static void Write(HttpResponse response, string publicBaseUrl, string? error = null)
    {
        response.StatusCode = StatusCodes.Status401Unauthorized;
        var challenge = $"Bearer resource_metadata=\"{ResourceMetadataUrl(publicBaseUrl)}\", scope=\"{Scope}\"";
        if (error is not null) challenge = $"Bearer error=\"{error}\", " + challenge["Bearer ".Length..];
        response.Headers.WWWAuthenticate = challenge;
    }
}
