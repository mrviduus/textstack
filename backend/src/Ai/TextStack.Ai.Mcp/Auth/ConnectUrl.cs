using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace TextStack.Ai.Mcp.Auth;

/// <summary>
/// The personal connect URL, <c>/mcp/k/&lt;tsk_…&gt;</c>, for MCP clients that cannot send a header.
/// ChatGPT's connector settings offer "No authentication" or OAuth and nothing in between, so until
/// there is OAuth the key has to travel in the URL.
///
/// The key is lifted into <c>Authorization: Bearer</c> and the path becomes <c>/mcp</c>. Everything
/// downstream is then the ordinary bearer path, unchanged: <see cref="HttpContextTokenProvider"/>
/// reads the header, the API resolves the key and honours revocation on every request. Nothing here
/// validates the key beyond its shape — the API is the only authority on whether it is live.
///
/// The URL is a password. The host keeps request-path logging off (see <see cref="McpHosts"/>) and
/// nginx has <c>access_log off</c> for <c>/mcp/k/</c>; Cloudflare, in front of both, still sees it.
/// </summary>
public static class ConnectUrl
{
    public const string PathPrefix = "/mcp/k/";

    // McpKeys.Generate: "tsk_" + 32 bytes in unpadded base64url = 43 chars. Compiled Regex, not
    // [GeneratedRegex] — the ARM64 SIGILL caveat in CLAUDE.md.
    private static readonly Regex KeyShape = new("^tsk_[A-Za-z0-9_-]{43}$", RegexOptions.Compiled);

    /// <summary>
    /// Rewrites a connect-URL request in place. Returns <c>false</c> only when the path is under
    /// <see cref="PathPrefix"/> but the key is malformed — the caller answers 404, so a typo'd URL
    /// never falls through to <c>/mcp</c> as an anonymous session that "works" for public tools.
    /// An explicit <c>Authorization</c> header wins over the URL.
    /// </summary>
    public static bool TryRewrite(HttpRequest request)
    {
        var path = request.Path.Value;
        if (path is null || !path.StartsWith(PathPrefix, StringComparison.Ordinal))
            return true;

        var key = path[PathPrefix.Length..].TrimEnd('/');
        if (!KeyShape.IsMatch(key))
            return false;

        if (string.IsNullOrEmpty(request.Headers.Authorization))
            request.Headers.Authorization = "Bearer " + key;
        request.Path = "/mcp";
        return true;
    }
}
