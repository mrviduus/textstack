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
    private static McpToolCatalog BuildCatalog()
    {
        // The catalog only invokes the api/token provider when a tool is CALLED;
        // listing/constructing it does not — so any stub client is fine.
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "http://localhost",
            SiteHost = "textstack.app",
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

    [Fact]
    public void ManifestToolDescriptions_MatchRuntimeCatalog()
    {
        var catalog = BuildCatalog().ListTools()
            .ToDictionary(t => t.Name, t => t.Description, StringComparer.Ordinal);

        foreach (var tool in McpManifestCatalog.Tools)
        {
            Assert.True(catalog.TryGetValue(tool.Name, out var description),
                $"manifest advertises '{tool.Name}' which the runtime catalog does not expose");
            Assert.Equal(description, tool.Description);
        }
    }

    [Fact]
    public void Manifest_AdvertisesTheWholeToolSurface()
    {
        Assert.Equal(13, McpManifestCatalog.Tools.Count);
    }

    private sealed class NoTokenProvider : IMcpTokenProvider
    {
        public Task<TokenResult> GetTokenAsync(CancellationToken ct) =>
            Task.FromResult<TokenResult>(new TokenResult.Failed("no token (drift test)"));
    }
}
