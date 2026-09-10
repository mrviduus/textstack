using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-048a — the 5 READ MCP tools appended to the AI-047 catalog: get_book,
/// get_chapter, list_my_highlights, list_my_vocabulary. Verifies
/// tools/list discovery + schemas, per-tool request shape (method/path/Host/Bearer)
/// and JSON→MCP mapping, arg validation gates, the auth-required fail-clean path,
/// get_chapter HTML strip + cap, and the shared
/// upstream-error wrapper — all against a fake HTTP layer (CI-safe, no network).
///
/// Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
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

    private const string Edition = "33333333-3333-3333-3333-333333333333";

    // ── tools/list: the whole surface, with correct schemas ──────────────────────

    [Fact]
    public void ListTools_ExposesTheWholeSurface()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));

        var names = catalog.ListTools().Select(t => t.Name).OrderBy(n => n).ToArray();

        Assert.Equal(
            ["get_book", "get_chapter", "get_my_book", "get_my_chapter", "get_my_insights", "list_my_book_highlights", "list_my_highlights", "list_my_vocabulary", "save_highlight", "save_insight", "save_my_highlight", "search_books", "search_my_library"],
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

        Assert.Equal(["slug"], Required(byName["get_book"]));
        Assert.Equal(["slug", "chapterSlug"], Required(byName["get_chapter"]));
        Assert.Equal(["editionId"], Required(byName["list_my_highlights"]));
        Assert.Empty(Required(byName["list_my_vocabulary"]));
        // The my-library tools are keyed by bookId — never editionId. The schema is
        // where that distinction is enforced, so it is asserted here.
        Assert.Equal(["query"], Required(byName["search_my_library"]));
        Assert.Equal(["bookId"], Required(byName["get_my_book"]));
        Assert.Equal(["bookId", "chapterSlug"], Required(byName["get_my_chapter"]));
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

    // ── get_book: public, no Bearer, maps editionId + metadata ───────────────────

    [Fact]
    public async Task GetBook_IssuesPublicGet_NoBearer_MapsEditionIdAndMetadata()
    {
        const string body =
            """
            {
              "id": "33333333-3333-3333-3333-333333333333",
              "slug": "alice",
              "title": "Alice",
              "language": "en",
              "description": "A tale.",
              "authors": [{ "id": "1", "slug": "lc", "name": "Lewis Carroll", "role": "author" }],
              "genres": [{ "id": "2", "slug": "fantasy", "name": "Fantasy" }],
              "chapters": [{ "id": "9", "chapterNumber": 1, "slug": "ch-1", "title": "Down", "wordCount": 1200 }]
            }
            """;
        var (catalog, handler) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync("get_book", Args("""{"slug":"alice"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Get, handler.LastRequest!.Method);
        Assert.Equal("/books/alice", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
        Assert.Null(BearerOf(handler.LastRequest)); // public → no Authorization

        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Equal(Edition, root.GetProperty("editionId").GetString());
        Assert.Equal("Alice", root.GetProperty("title").GetString());
        Assert.Equal("Lewis Carroll", root.GetProperty("authors")[0].GetString());
        Assert.Equal("Fantasy", root.GetProperty("genres")[0].GetString());
        var ch = root.GetProperty("chapters")[0];
        Assert.Equal(1, ch.GetProperty("chapterNumber").GetInt32());
        Assert.Equal("ch-1", ch.GetProperty("slug").GetString());
        Assert.Equal(1200, ch.GetProperty("wordCount").GetInt32());
    }

    [Fact]
    public async Task GetBook_NotFound_ReturnsToolError()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync("get_book", Args("""{"slug":"missing"}"""), CancellationToken.None);

        Assert.True(result.IsError);
    }

    [Theory]
    [InlineData("""{}""")]                       // missing slug
    [InlineData("""{"slug":123}""")]             // wrong type
    [InlineData("""{"slug":""}""")]              // too short
    [InlineData("""{"slug":"x","extra":1}""")]   // additionalProperties:false
    public async Task GetBook_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("get_book", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    // ── get_chapter: public, HTML strip + cap, prev/next ─────────────────────────

    [Fact]
    public async Task GetChapter_IssuesPublicGet_NoBearer_StripsHtmlAndMapsNav()
    {
        const string body =
            """
            {
              "id": "9",
              "chapterNumber": 2,
              "slug": "ch-2",
              "title": "Pool",
              "html": "<p>Hello <b>world</b> &amp; friends.</p>",
              "wordCount": 5,
              "edition": { "id": "33333333-3333-3333-3333-333333333333", "slug": "alice", "title": "Alice", "language": "en" },
              "prev": { "slug": "ch-1", "title": "Down" },
              "next": { "slug": "ch-3", "title": "Caucus" }
            }
            """;
        var (catalog, handler) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync(
            "get_chapter", Args("""{"slug":"alice","chapterSlug":"ch-2"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal("/books/alice/chapters/ch-2", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
        Assert.Null(BearerOf(handler.LastRequest));

        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Equal(2, root.GetProperty("chapterNumber").GetInt32());
        Assert.Equal("ch-1", root.GetProperty("prevSlug").GetString());
        Assert.Equal("ch-3", root.GetProperty("nextSlug").GetString());
        Assert.False(root.GetProperty("truncated").GetBoolean());
        // Tags stripped, entity decoded, whitespace collapsed.
        Assert.Equal("Hello world & friends.", root.GetProperty("text").GetString());
    }

    [Fact]
    public async Task GetChapter_LongHtml_TruncatesAndFlags()
    {
        var bigText = new string('a', 60_000);
        var body = $$"""
            {
              "chapterNumber": 1, "slug": "ch-1", "title": "T",
              "html": "<p>{{bigText}}</p>",
              "edition": { "id": "33333333-3333-3333-3333-333333333333", "slug": "s", "title": "T", "language": "en" }
            }
            """;
        var (catalog, _) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync(
            "get_chapter", Args("""{"slug":"s","chapterSlug":"ch-1"}"""), CancellationToken.None);

        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.True(root.GetProperty("truncated").GetBoolean());
        Assert.Equal(40_000, root.GetProperty("text").GetString()!.Length);
    }

    [Theory]
    [InlineData("""{"slug":"s"}""")]                    // missing chapterSlug
    [InlineData("""{"chapterSlug":"c"}""")]             // missing slug
    [InlineData("""{"slug":"s","chapterSlug":1}""")]    // wrong type
    [InlineData("""{"slug":"s","chapterSlug":"c","x":1}""")] // extra prop
    public async Task GetChapter_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("get_chapter", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    // ── list_my_highlights: Bearer, maps fields ──────────────────────────────────

    [Fact]
    public async Task ListMyHighlights_IssuesAuthorizedGet_MapsFields()
    {
        const string body =
            """
            [
              {
                "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "editionId": "33333333-3333-3333-3333-333333333333",
                "chapterId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                "userBookId": null, "userChapterId": null,
                "anchorJson": "{}", "color": "yellow",
                "selectedText": "a curious thing", "noteText": "note!",
                "version": 1,
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-01T00:00:00+00:00"
              }
            ]
            """;
        var (catalog, handler) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync(
            "list_my_highlights", Args($$"""{"editionId":"{{Edition}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Get, handler.LastRequest!.Method);
        Assert.Equal($"/me/highlights/{Edition}", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest)); // user-scoped → Bearer

        var first = Assert.Single(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("highlights").EnumerateArray());
        Assert.Equal("yellow", first.GetProperty("color").GetString());
        Assert.Equal("a curious thing", first.GetProperty("selectedText").GetString());
        Assert.Equal("note!", first.GetProperty("noteText").GetString());
    }

    [Fact]
    public async Task ListMyHighlights_InvalidGuid_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"));

        var result = await catalog.CallAsync(
            "list_my_highlights", Args("""{"editionId":"not-a-guid"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task ListMyHighlights_NullToken_ReturnsAuthRequired_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"), token: null);

        var result = await catalog.CallAsync(
            "list_my_highlights", Args($$"""{"editionId":"{{Edition}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task ListMyHighlights_Api401_ReturnsAuthRequired()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.Unauthorized));

        var result = await catalog.CallAsync(
            "list_my_highlights", Args($$"""{"editionId":"{{Edition}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
    }

    // ── list_my_vocabulary: Bearer, optional params omitted, maps {total,items} ──

    [Fact]
    public async Task ListMyVocabulary_NoArgs_OmitsParams_IssuesAuthorizedGet()
    {
        const string body =
            """
            {
              "total": 1,
              "items": [
                {
                  "id": "1", "word": "ephemeral", "language": "en",
                  "translation": "minulé", "definition": "short-lived",
                  "editionId": null, "chapterId": null, "userBookId": null,
                  "sentence": null, "bookTitle": "Alice", "hint": null,
                  "stage": 2, "intervalDays": 3, "consecutiveCorrect": 1,
                  "nextReviewAt": "2026-02-01T00:00:00+00:00", "lastReviewedAt": null,
                  "totalReviews": 4, "correctReviews": 3,
                  "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-01T00:00:00+00:00"
                }
              ]
            }
            """;
        var (catalog, handler) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync("list_my_vocabulary", Args("{}"), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal("/me/vocabulary/words", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));

        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Equal(1, root.GetProperty("total").GetInt32());
        var item = root.GetProperty("items")[0];
        Assert.Equal("ephemeral", item.GetProperty("word").GetString());
        Assert.Equal(2, item.GetProperty("stage").GetInt32());
        Assert.Equal("Alice", item.GetProperty("bookTitle").GetString());
    }

    [Fact]
    public async Task ListMyVocabulary_WithAllParams_BuildsQueryString()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync(
            "list_my_vocabulary",
            Args("""{"stage":3,"search":"foo bar","limit":25,"offset":50}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var q = handler.LastRequest!.RequestUri!.PathAndQuery;
        Assert.StartsWith("/me/vocabulary/words?", q);
        Assert.Contains("stage=3", q);
        Assert.Contains("search=foo%20bar", q);
        Assert.Contains("limit=25", q);
        Assert.Contains("offset=50", q);
    }

    [Theory]
    [InlineData("""{"stage":5}""")]        // stage above max
    [InlineData("""{"stage":-1}""")]       // stage below min
    [InlineData("""{"limit":0}""")]        // limit below min
    [InlineData("""{"limit":101}""")]      // limit above max
    [InlineData("""{"offset":-1}""")]      // negative offset
    [InlineData("""{"bogus":1}""")]        // additionalProperties:false
    [InlineData("""{"search":123}""")]     // wrong type
    public async Task ListMyVocabulary_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("list_my_vocabulary", Args(args), CancellationToken.None);

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

    // ── ask_book: POST Bearer, maps answer + citations, spoiler gate ─────────────

    // ── shared upstream-error wrapper: every tool fails-clean + propagates cancel ─

    public static IEnumerable<object[]> ToolCalls()
    {
        yield return ["get_book", """{"slug":"alice"}"""];
        yield return ["get_chapter", """{"slug":"alice","chapterSlug":"ch-1"}"""];
        yield return ["list_my_highlights", $$"""{"editionId":"{{Edition}}"}"""];
        yield return ["list_my_vocabulary", "{}"];
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

    // ── mapping-defect containment: a 200 + well-formed JSON whose shape leaves a
    // required member null can NRE the LINQ projection. That throw is NOT
    // Http/Json/Cancel, so the catch-all in InvokeAsync must turn it into a clean
    // tool error rather than letting it escape to an opaque JSON-RPC -32603 fault.

    [Fact]
    public async Task SearchBooks_NullEditionInItem_ReturnsCleanToolError_DoesNotEscape()
    {
        // edition:null → SearchResultDto ctor rejects null (JsonException, caught) —
        // documents that this path is already contained.
        var (catalog, _) = BuildCatalog(Json(
            """{"total":1,"items":[{"chapterId":"11111111-1111-1111-1111-111111111111","chapterNumber":1,"edition":null,"highlights":null}]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"xy"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("search_books failed", TextOf(result));
    }

}
