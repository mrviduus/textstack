using Contracts.Mcp;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// AI-052 drift guard: the public discovery manifest's advertised tool surface
/// (<see cref="McpManifestCatalog.Tools"/> in Contracts — mirrored into the API,
/// which cannot reference this Mcp executable) MUST match the runtime
/// <see cref="McpToolCatalog"/> served over <c>tools/list</c>. This assembly is
/// the one place that sees BOTH, so the assertion fails the build if either side
/// adds/renames/re-describes a tool without updating the other.
/// </summary>
public class McpManifestDriftTests
{
    private static McpToolCatalog BuildCatalog(bool v2 = false)
    {
        // The catalog only invokes the api/token provider when a tool is CALLED;
        // listing/constructing it does not — so any stub client is fine.
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "http://localhost",
            SiteHost = "textstack.app",
            V2 = v2,
        };
        var http = new HttpClient { BaseAddress = new Uri(options.ApiBaseUrl) };
        var api = new TextStackApiClient(http, options, new NoTokenProvider());
        return new McpToolCatalog(api);
    }

    // #1101: the manifest a server serves with Features:V2Api = v2 lists exactly the tools a bridge with
    // the same V2 switch registers. Lists of names, sorted — not counts.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ServedManifest_SameFlag_ListsExactlyTheRegisteredTools(bool v2)
    {
        var registered = BuildCatalog(v2).ListTools().Select(t => t.Name).Order(StringComparer.Ordinal);
        var served = McpManifestCatalog.Served(v2).Select(t => t.Name).Order(StringComparer.Ordinal);

        Assert.Equal(registered, served);
    }

    // The one literal: the surface size is a deliberate change (CLAUDE.md "MCP tool count").
    [Fact]
    public void Manifest_AdvertisesTheWholeToolSurface()
    {
        Assert.Equal((21, 24), (McpManifestCatalog.Served(false).Count, McpManifestCatalog.Served(true).Count));
    }

    private sealed class NoTokenProvider : IMcpTokenProvider
    {
        public Task<TokenResult> GetTokenAsync(CancellationToken ct) =>
            Task.FromResult<TokenResult>(new TokenResult.Failed("no token (drift test)"));
    }
}
