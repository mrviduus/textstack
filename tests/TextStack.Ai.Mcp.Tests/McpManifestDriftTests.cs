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

    [Fact]
    public void ManifestToolNames_MatchRuntimeCatalog()
    {
        var catalogNames = BuildCatalog().ListTools().Select(t => t.Name).ToHashSet();
        var manifestNames = McpManifestCatalog.Tools.Select(t => t.Name).ToHashSet();

        Assert.Equal(catalogNames, manifestNames);
    }

    // The discussion tools are served only by a V2 bridge, and described in Contracts like every other.
    [Fact]
    public void ManifestToolNamesWithTheV2Tools_MatchTheRuntimeCatalogOnV2()
    {
        var catalogNames = BuildCatalog(v2: true).ListTools().Select(t => t.Name).ToHashSet();
        var manifestNames = McpManifestCatalog.Tools.Concat(McpManifestCatalog.V2Tools).Select(t => t.Name).ToHashSet();

        Assert.Equal(catalogNames, manifestNames);
    }

    [Fact]
    public void Manifest_AdvertisesTheWholeToolSurface()
    {
        Assert.Equal(21, McpManifestCatalog.Tools.Count);
        Assert.Equal(24, McpManifestCatalog.Tools.Count + McpManifestCatalog.V2Tools.Count);
    }

    private sealed class NoTokenProvider : IMcpTokenProvider
    {
        public Task<TokenResult> GetTokenAsync(CancellationToken ct) =>
            Task.FromResult<TokenResult>(new TokenResult.Failed("no token (drift test)"));
    }
}
