using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Contracts.Mcp;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the MCP discovery manifest (AI-052).
/// Runs against the live API at localhost:8080 (gated/skipped like the rest of
/// this suite when the endpoint is unavailable). The internal API path is
/// <c>/mcp/manifest</c>; nginx exposes it publicly at
/// <c>/.well-known/mcp/manifest.json</c>.
/// </summary>
public class McpManifestEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public McpManifestEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task GetManifest_Anonymous_Returns200Json()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/mcp/manifest");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task GetManifest_ReturnsExpectedShape()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/mcp/manifest");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");

        var manifest = await response.Content.ReadFromJsonAsync<McpManifest>(
            cancellationToken: TestContext.Current.CancellationToken);

        Assert.NotNull(manifest);
        Assert.Equal("textstack", manifest.Name);
        Assert.Equal("streamable-http", manifest.Transport);
        Assert.EndsWith("/mcp", manifest.Endpoint);
        Assert.False(string.IsNullOrWhiteSpace(manifest.Documentation));
        Assert.Equal("oauth2", manifest.Auth.Type);
    }

    // #1101: the manifest follows the server's Features:V2Api. The flag is read from /health/ready
    // (components.v2 is "off" exactly when it is off), not from the manifest under test.
    [Fact]
    public async Task GetManifest_ServerV2Flag_ListsExactlyTheToolsServedUnderIt()
    {
        var ct = TestContext.Current.CancellationToken;
        var request = _fixture.CreateRequest(HttpMethod.Get, "/mcp/manifest");
        var response = await _fixture.Client.SendAsync(request, ct);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");

        var manifest = await response.Content.ReadFromJsonAsync<McpManifest>(cancellationToken: ct);
        var health = await (await _fixture.Client.GetAsync("/health/ready", ct)).Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.SkipWhen(!health.GetProperty("components").TryGetProperty("v2", out var v2Component),
            "API predates the v2 readiness component");
        var v2Api = v2Component.GetProperty("status").GetString() != "off";

        Assert.NotNull(manifest);
        Assert.Equal(
            McpManifestCatalog.Served(v2Api).Select(t => t.Name).Order(StringComparer.Ordinal),
            manifest.Tools.Select(t => t.Name).Order(StringComparer.Ordinal));
        Assert.Equal(v2Api ? 24 : 21, manifest.Tools.Count); // the size guard (CLAUDE.md "MCP tool count")
        Assert.All(manifest.Tools, t => Assert.False(string.IsNullOrWhiteSpace(t.Description)));
    }
}
