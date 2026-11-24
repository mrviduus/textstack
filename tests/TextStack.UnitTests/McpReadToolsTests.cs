using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// The read side of the MCP catalog against a fake V2 API (CI-safe, no network): tools/list discovery
/// and schemas, list_my_vocabulary over the V2 feed (filtered and paged in the bridge), argument gates,
/// the auth-required fail-clean path and the shared upstream-error wrapper.
/// </summary>
public class McpReadToolsTests
{
    private const string SiteHost = "textstack.test";

    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }

        // Body is captured here because the client disposes the request (and its
        // content) once SendAsync returns — reading it from LastRequest later throws.
        public string? LastRequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            if (request.Content is not null)
                LastRequestBody = await request.Content.ReadAsStringAsync(cancellationToken);
            return response;
        }
    }

    private sealed class ThrowingHandler(Func<CancellationToken, Exception> factory) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw factory(cancellationToken);
    }

    // token: non-null → auth present; null → auth absent (user-scoped fail-clean).
    private static (McpToolCatalog catalog, CapturingHandler handler) BuildCatalog(
        HttpResponseMessage response, string? token = "tok-123")
    {
        var handler = new CapturingHandler(response);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost, McpToken = token };
        var api = new TextStackApiClient(http, options, new StaticEnvTokenProvider(options));
        return (new McpToolCatalog(api), handler);
    }

    private static McpToolCatalog BuildCatalogThatThrows(Func<CancellationToken, Exception> factory, string? token = "tok-123")
    {
        var http = new HttpClient(new ThrowingHandler(factory)) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost, McpToken = token };
        return new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options)));
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult result) => ((TextContentBlock)result.Content[0]).Text;

    private static string? BearerOf(HttpRequestMessage req) => req.Headers.Authorization?.ToString();

    private const string Book = "33333333-3333-3333-3333-333333333333";

    // ── tools/list: the whole surface, with correct schemas ──────────────────────

    [Fact]
    public void ListTools_ExposesTheWholeSurface()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));

        var names = catalog.ListTools().Select(t => t.Name).OrderBy(n => n).ToArray();

        Assert.Equal(
            ["add_vocabulary_words", "delete_checkpoint", "delete_vocabulary_word", "get_book_progress", "get_my_book", "get_my_insights", "get_my_reading", "get_shared_chapter", "list_checkpoints", "list_my_book_highlights", "list_my_vocabulary", "save_checkpoint", "save_insight", "save_my_highlight", "search_my_library", "set_book_progress", "share_chapter", "update_vocabulary_word"],
            names);
    }

    [Fact]
    public void ListTools_AllSchemas_AreObjectsWithAdditionalPropertiesFalse()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));

        foreach (var tool in catalog.ListTools())
        {
            Assert.Equal("object", tool.InputSchema.GetProperty("type").GetString());
            Assert.False(tool.InputSchema.GetProperty("additionalProperties").GetBoolean(),
                $"{tool.Name} must set additionalProperties:false");
        }
    }

    [Fact]
    public void ListTools_RequiredFields_MatchSpec()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));
        var byName = catalog.ListTools().ToDictionary(t => t.Name);

        static string[] Required(Tool t) =>
            t.InputSchema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).ToArray();

        Assert.Empty(Required(byName["list_my_vocabulary"]));
        Assert.Equal(["query"], Required(byName["search_my_library"]));
        Assert.Equal(["bookId"], Required(byName["get_my_book"]));
    }

    [Fact]
    public void ListTools_Vocabulary_DeclaresBounds()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));
        var byName = catalog.ListTools().ToDictionary(t => t.Name);

        var stage = byName["list_my_vocabulary"].InputSchema.GetProperty("properties").GetProperty("stage");
        Assert.Equal(0, stage.GetProperty("minimum").GetInt32());
        Assert.Equal(4, stage.GetProperty("maximum").GetInt32());
    }

    // ── list_my_vocabulary: Bearer, optional params omitted, maps {total,items} ──

    private static string Card(string id, string word, string? translation, int stage, string createdAt, string? deletedAt = null) =>
        $$"""
        {
          "id": "{{id}}", "language": "en", "word": "{{word}}", "translation": {{(translation is null ? "null" : $"\"{translation}\"")}},
          "definition": null, "stage": {{stage}}, "intervalDays": 1, "consecutiveCorrect": 0, "nextReviewAt": "2026-02-01T00:00:00Z",
          "lastReviewedAt": null, "createdAt": "{{createdAt}}", "updatedAt": "{{createdAt}}",
          "deletedAt": {{(deletedAt is null ? "null" : $"\"{deletedAt}\"")}}, "retiredAt": null, "revision": 1,
          "examples": [{ "id": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "operationId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
                         "sentence": "s", "bookId": null, "bookTitle": "Alice", "createdAt": "{{createdAt}}" }]
        }
        """;

    // The V2 feed holds every card: the bridge drops the deleted, filters by stage and search (word or
    // translation), sorts newest first and pages, as the list the tool describes.
    [Fact]
    public async Task ListMyVocabulary_FilteredAndPaged_FromTheV2Feed()
    {
        var feed = $$"""
            { "items": [
              {{Card("11111111-1111-1111-1111-111111111111", "ephemeral", "минулий", 2, "2026-01-01T00:00:00Z")}},
              {{Card("22222222-2222-2222-2222-222222222222", "fleeting", "минущий", 2, "2026-01-03T00:00:00Z")}},
              {{Card("33333333-3333-3333-3333-333333333333", "gone", "минув", 2, "2026-01-04T00:00:00Z", deletedAt: "2026-01-05T00:00:00Z")}},
              {{Card("44444444-4444-4444-4444-444444444444", "stone", "камінь", 0, "2026-01-02T00:00:00Z")}}
            ], "cursor": null, "hasMore": false }
            """;
        var (catalog, handler) = BuildCatalog(Json(feed));

        var result = await catalog.CallAsync("list_my_vocabulary", Args("""{"stage":2,"search":"мину","limit":1,"offset":1}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.StartsWith("/me/v2/vocabulary/changes?", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));
        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Equal(2, root.GetProperty("total").GetInt32());
        var item = Assert.Single(root.GetProperty("items").EnumerateArray());
        Assert.Equal("ephemeral", item.GetProperty("word").GetString());
        Assert.Equal("11111111-1111-1111-1111-111111111111", item.GetProperty("id").GetString());
        Assert.Equal("Alice", item.GetProperty("bookTitle").GetString());
    }

    [Theory]
    [InlineData("list_my_vocabulary", """{"stage":5}""")]        // stage above max
    [InlineData("list_my_vocabulary", """{"stage":-1}""")]       // stage below min
    [InlineData("list_my_vocabulary", """{"limit":0}""")]        // limit below min
    [InlineData("list_my_vocabulary", """{"limit":101}""")]      // limit above max
    [InlineData("list_my_vocabulary", """{"offset":-1}""")]      // negative offset
    [InlineData("list_my_vocabulary", """{"bogus":1}""")]        // additionalProperties:false
    [InlineData("list_my_vocabulary", """{"search":123}""")]     // wrong type
    [InlineData("search_my_library", """{"query":"a"}""")]       // query too short
    [InlineData("get_my_book", """{"bookId":"not-a-uuid"}""")]
    [InlineData("save_my_highlight", $$"""{"bookId":"{{Book}}","chapterId":"{{Book}}","selectedText":"x","color":"orange"}""")]
    [InlineData("list_my_book_highlights", "{}")]
    [InlineData("save_insight", $$"""{"editionId":"{{Book}}","text":"x"}""")] // no bookId (editionId is not an argument)
    [InlineData("get_my_insights", "{}")]                        // no id
    public async Task AnyTool_InvalidArgs_ReturnsToolError_NeverHitsHttp(string tool, string args)
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync(tool, Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task ListMyVocabulary_NullToken_ReturnsAuthRequired_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""), token: null);

        var result = await catalog.CallAsync("list_my_vocabulary", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    // ── shared upstream-error wrapper: every tool fails-clean + propagates cancel ─

    public static IEnumerable<object[]> ToolCalls()
    {
        yield return ["list_my_vocabulary", "{}"];
        yield return ["get_my_book", $$"""{"bookId":"{{Book}}"}"""];
        yield return ["get_my_insights", $$"""{"bookId":"{{Book}}"}"""];
        yield return ["get_my_reading", "{}"];
    }

    [Theory]
    [MemberData(nameof(ToolCalls))]
    public async Task AnyTool_ConnectionFailure_ReturnsCleanToolError(string tool, string args)
    {
        var catalog = BuildCatalogThatThrows(_ => new HttpRequestException("refused"));

        var result = await catalog.CallAsync(tool, Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains($"{tool} failed", TextOf(result));
    }

    [Theory]
    [MemberData(nameof(ToolCalls))]
    public async Task AnyTool_Timeout_ReturnsCleanToolError(string tool, string args)
    {
        var catalog = BuildCatalogThatThrows(_ => new TaskCanceledException("timeout"));

        var result = await catalog.CallAsync(tool, Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains($"{tool} failed: upstream timed out", TextOf(result));
    }

    [Theory]
    [MemberData(nameof(ToolCalls))]
    public async Task AnyTool_MalformedJsonBody_ReturnsCleanToolError(string tool, string args)
    {
        var (catalog, _) = BuildCatalog(Json("<html>nope</html>"));

        var result = await catalog.CallAsync(tool, Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains($"{tool} failed", TextOf(result));
    }

    [Theory]
    [MemberData(nameof(ToolCalls))]
    public async Task AnyTool_RealClientCancellation_Propagates(string tool, string args)
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var catalog = BuildCatalogThatThrows(ct => new OperationCanceledException(ct));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => catalog.CallAsync(tool, Args(args), cts.Token));
    }
}
