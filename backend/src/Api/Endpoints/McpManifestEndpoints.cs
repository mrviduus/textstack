using Contracts.Mcp;

namespace Api.Endpoints;

/// <summary>
/// MCP discovery manifest (AI-052). Anonymous, cacheable JSON describing the live
/// MCP endpoint, auth, docs, and tool surface for MCP clients / tooling.
///
/// INTERNAL path: <c>GET /mcp/manifest</c>. The PUBLIC path is
/// <c>/.well-known/mcp/manifest.json</c> — nginx maps it here with an exact-match
/// location so it does NOT collide with the live <c>/mcp</c> protocol prefix
/// (owned by the mcp-server container; <c>MapMcp("/mcp")</c> owns /mcp + subpaths).
///
/// Base URL comes from <c>App:BaseUrl</c> (same key DeviceAuthEndpoints uses); the
/// live MCP endpoint is <c>{BaseUrl}/mcp</c>. Host is never hardcoded.
/// </summary>
public static class McpManifestEndpoints
{
    public static void MapMcpManifestEndpoints(this WebApplication app)
    {
        app.MapGet("/mcp/manifest", GetManifest)
            .WithName("McpManifest")
            .WithTags("Mcp")
            .AllowAnonymous();
    }

    private static IResult GetManifest(HttpContext httpContext, IConfiguration config)
    {
        var baseUrl = (config["App:BaseUrl"] ?? "https://textstack.app").TrimEnd('/');
        var docsUrl = $"{baseUrl}/en/mcp";

        var manifest = new McpManifest(
            Name: "textstack",
            Version: "1.0.0",
            Description: "Query your TextStack reading library from any MCP client.",
            Transport: "streamable-http",
            Endpoint: $"{baseUrl}/mcp",
            Auth: new McpManifestAuth(Type: "oauth2", HowTo: docsUrl), // ADR-017: authorization code + PKCE; device flow still serves stdio
            Documentation: docsUrl,
            Tools: McpManifestCatalog.Tools);

        // Public, cacheable discovery document.
        httpContext.Response.Headers.CacheControl = "public, max-age=3600";

        return Results.Ok(manifest);
    }
}
