using System.Net;
using System.Net.Http.Json;
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

    private static readonly string[] ExpectedToolNames =
    [
        "search_books",
        "get_book",
        "get_chapter",
        "search_my_library",
        "get_my_book",
        "get_my_chapter",
        "list_my_highlights",
        "list_my_vocabulary",
        "save_highlight",
        "save_my_highlight",
        "list_my_book_highlights",
        "save_insight",
        "get_my_insights",
        "get_my_reading",
        "get_book_progress",
        "set_book_progress",
    ];

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
        Assert.Equal("oauth-device", manifest.Auth.Type);
    }

    [Fact]
    public async Task GetManifest_ListsTheExpectedTools()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/mcp/manifest");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");

        var manifest = await response.Content.ReadFromJsonAsync<McpManifest>(
            cancellationToken: TestContext.Current.CancellationToken);

        Assert.NotNull(manifest);
        Assert.Equal(16, manifest.Tools.Count);

        var names = manifest.Tools.Select(t => t.Name).ToHashSet();
        Assert.Equal(ExpectedToolNames.ToHashSet(), names);
        Assert.All(manifest.Tools, t => Assert.False(string.IsNullOrWhiteSpace(t.Description)));
    }
}
