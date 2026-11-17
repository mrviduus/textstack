using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// The MCP tool catalog's dispatch, testable without network or a stdio subprocess: an unknown tool,
/// and the tools (or arguments) legacy served, which answer that they are retired without a call.
/// </summary>
public class McpServerTests
{
    /// <summary>Records every request; any request is a failure of these tests.</summary>
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private static (McpToolCatalog catalog, RecordingHandler handler) BuildCatalog()
    {
        var handler = new RecordingHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = "textstack.test", McpToken = "t" };
        return (new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options))), handler);
    }

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public async Task Call_UnknownTool_ReturnsToolError()
    {
        var (catalog, _) = BuildCatalog();

        var result = await catalog.CallAsync("does_not_exist", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
    }

    // A reader's assistant asks for the catalog, an edition or a chapter review: it is told the feature
    // is retired (never an empty answer that reads like "nothing there"), and nothing is sent.
    [Theory]
    [InlineData("search_books", """{"query":"dracula"}""")]
    [InlineData("get_book", """{"slug":"dracula"}""")]
    [InlineData("get_chapter", """{"slug":"dracula","chapterSlug":"one"}""")]
    [InlineData("list_my_highlights", """{"editionId":"33333333-3333-3333-3333-333333333333"}""")]
    [InlineData("save_highlight", """{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"44444444-4444-4444-4444-444444444444","selectedText":"x"}""")]
    [InlineData("get_chapter_review", """{"bookId":"33333333-3333-3333-3333-333333333333","chapterSlug":"one"}""")]
    [InlineData("save_chapter_review", """{"bookId":"33333333-3333-3333-3333-333333333333","chapterSlug":"one","review":{}}""")]
    [InlineData("get_my_insights", """{"editionId":"33333333-3333-3333-3333-333333333333"}""")]
    [InlineData("save_insight", """{"editionId":"33333333-3333-3333-3333-333333333333","text":"x"}""")]
    [InlineData("get_book_progress", """{"editionId":"33333333-3333-3333-3333-333333333333"}""")]
    [InlineData("set_book_progress", """{"slug":"dracula","chapterSlug":"one"}""")]
    public async Task Call_RetiredToolOrCatalogArgument_SaysRetired_SendsNothing(string tool, string args)
    {
        var (catalog, handler) = BuildCatalog();

        var result = await catalog.CallAsync(tool, Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Equal($"{tool} failed: this feature is retired in this version.", ((TextContentBlock)result.Content[0]).Text);
        Assert.Empty(handler.Requests);
    }
}
