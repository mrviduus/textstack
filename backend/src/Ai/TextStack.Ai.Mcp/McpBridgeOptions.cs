namespace TextStack.Ai.Mcp;

/// <summary>
/// Environment-driven config for the stateless MCP↔HTTP bridge.
/// </summary>
public sealed class McpBridgeOptions
{
    /// <summary>Base URL of the TextStack public API. Env: <c>TEXTSTACK_API_URL</c>.</summary>
    public required string ApiBaseUrl { get; init; }

    /// <summary>
    /// Host header sent on each bridged request so <c>SiteContextMiddleware</c>
    /// can resolve the site for unauthenticated <c>/search</c>. Env:
    /// <c>TEXTSTACK_SITE_HOST</c>.
    /// </summary>
    public required string SiteHost { get; init; }

    /// <summary>
    /// Bearer token for the user-scoped tools. When set, the bridge uses
    /// <see cref="Auth.StaticEnvTokenProvider"/> (CI / escape hatch) instead of the
    /// device flow. When unset, the default is
    /// <see cref="Auth.DeviceFlowTokenProvider"/>. Env: <c>TEXTSTACK_MCP_TOKEN</c>.
    /// </summary>
    public string? McpToken { get; init; }

    /// <summary>
    /// Optional explicit path for the device-flow token cache file. When unset,
    /// <see cref="Auth.TokenCache.ResolvePath"/> uses
    /// <c>$XDG_CONFIG_HOME/textstack/mcp-token.json</c> (or
    /// <c>~/.textstack/mcp-token.json</c>). Env: <c>TEXTSTACK_MCP_TOKEN_CACHE</c>.
    /// </summary>
    public string? TokenCachePath { get; init; }

    /// <summary>
    /// Server transport (AI-049). <c>stdio</c> (default) = the local single-identity
    /// host (device-flow / static token). <c>http</c> = the remote, multi-user
    /// streamable HTTP host behind nginx, where each connection carries its own
    /// <c>Authorization: Bearer</c> (see
    /// <see cref="Auth.HttpContextTokenProvider"/>). Env: <c>MCP_TRANSPORT</c>;
    /// the <c>--http</c> CLI flag also selects http. Defaults to <c>stdio</c> so
    /// callers that don't set it keep the pre-049, byte-identical behaviour.
    /// </summary>
    public McpTransport Transport { get; init; } = McpTransport.Stdio;

    /// <summary>
    /// Public origin of the site (http mode): the OAuth issuer and the base of the MCP resource URL
    /// advertised in the 401 challenge and the protected-resource metadata. Must match the API's
    /// <c>App:BaseUrl</c>. Env: <c>TEXTSTACK_PUBLIC_URL</c>.
    /// </summary>
    public string PublicBaseUrl { get; init; } = "https://textstack.app";

    public static McpBridgeOptions FromEnvironment(string[]? args = null)
    {
        var apiUrl = Environment.GetEnvironmentVariable("TEXTSTACK_API_URL");
        if (string.IsNullOrWhiteSpace(apiUrl))
            apiUrl = "https://textstack.app/api";

        var siteHost = Environment.GetEnvironmentVariable("TEXTSTACK_SITE_HOST");
        if (string.IsNullOrWhiteSpace(siteHost))
            siteHost = "textstack.app";

        return new McpBridgeOptions
        {
            ApiBaseUrl = apiUrl.TrimEnd('/'),
            SiteHost = siteHost,
            // When set → static-token mode (CI / escape hatch); else device flow.
            McpToken = Environment.GetEnvironmentVariable("TEXTSTACK_MCP_TOKEN"),
            TokenCachePath = Environment.GetEnvironmentVariable("TEXTSTACK_MCP_TOKEN_CACHE"),
            Transport = ResolveTransport(
                Environment.GetEnvironmentVariable("MCP_TRANSPORT"), args),
            PublicBaseUrl = (Environment.GetEnvironmentVariable("TEXTSTACK_PUBLIC_URL") is { Length: > 0 } pub
                ? pub : "https://textstack.app").TrimEnd('/'),
        };
    }

    /// <summary>
    /// http when <c>MCP_TRANSPORT=http</c> (case-insensitive) OR the <c>--http</c>
    /// CLI flag is present; stdio otherwise (the default, byte-identical to today).
    /// Any unrecognized MCP_TRANSPORT value falls back to stdio.
    /// </summary>
    internal static McpTransport ResolveTransport(string? envValue, string[]? args)
    {
        if (args is not null && Array.Exists(args, a => string.Equals(a, "--http", StringComparison.OrdinalIgnoreCase)))
            return McpTransport.Http;

        return string.Equals(envValue?.Trim(), "http", StringComparison.OrdinalIgnoreCase)
            ? McpTransport.Http
            : McpTransport.Stdio;
    }
}

/// <summary>Selected MCP server transport (AI-049).</summary>
public enum McpTransport
{
    /// <summary>Local stdio (default). One process identity; device-flow / static token.</summary>
    Stdio,

    /// <summary>Remote streamable HTTP. Multi-user; per-request bearer.</summary>
    Http,
}
