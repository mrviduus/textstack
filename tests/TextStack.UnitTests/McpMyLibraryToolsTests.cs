using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// The my-library MCP tools — <c>search_my_library</c>, <c>get_my_book</c>,
/// <c>get_my_chapter</c> — which open a user's OWN uploads to an MCP client. The
/// catalog tools could already be reached; uploads could not, and that gap is the
/// whole reason these exist.
///
/// The assertion this file exists for is the identifier. An upload is a
/// <c>UserBook</c>: a different aggregate from <c>Edition</c>, with its own
/// chapter and chunk tables and NO editionId. A tool that returned an
/// <c>editionId</c> for an upload would hand the model an id that 404s in
/// <c>ask_book</c> and silently returns an empty list from
/// <c>list_my_highlights</c> — a failure that looks like an empty library rather
/// than a wrong id. So every output here is keyed by <c>bookId</c> and says
/// <c>source: "userbook"</c>, and the tests below check exactly that.
///
/// Same fake-HTTP harness as <see cref="McpReadToolsTests"/>: CI-safe, no network.
/// </summary>
public class McpMyLibraryToolsTests
{
    private const string SiteHost = "textstack.test";
    private const string Book = "77777777-7777-7777-7777-777777777777";
    private const string Chapter = "88888888-8888-8888-8888-888888888888";

    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }

        // Read here: the client disposes the request (and its content) once SendAsync
        // returns, so reading it off LastRequest afterwards throws.
        public string? LastRequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            if (request.Content is not null)
                LastRequestBody = await request.Content.ReadAsStringAsync(cancellationToken);
            return response;
        }
    }

    private static (McpToolCatalog catalog, CapturingHandler handler) BuildCatalog(
        HttpResponseMessage response, string? token = "tok-123")
    {
        var handler = new CapturingHandler(response);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost, McpToken = token };
        var api = new TextStackApiClient(http, options, new StaticEnvTokenProvider(options));
        return (new McpToolCatalog(api), handler);
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult result) => ((TextContentBlock)result.Content[0]).Text;

    private static JsonElement Body(CallToolResult result) => JsonDocument.Parse(TextOf(result)).RootElement;

    private static string? BearerOf(HttpRequestMessage req) => req.Headers.Authorization?.ToString();

    // ── search_my_library ───────────────────────────────────────────────────────

    private const string SearchBody =
        """
        [
          {
            "id": "77777777-7777-7777-7777-777777777777",
            "title": "Designing Data-Intensive Applications",
            "author": "Martin Kleppmann",
            "coverPath": "/storage/x.jpg",
            "language": "en",
            "rank": 0.42,
            "excerpt": "a <mark>quorum</mark> of replicas must acknowledge",
            "chapterSlug": "replication"
          }
        ]
        """;

    [Fact]
    public async Task SearchMyLibrary_IssuesAuthorizedGet_MapsBookIdAndChapterHit()
    {
        var (catalog, handler) = BuildCatalog(Json(SearchBody));

        var result = await catalog.CallAsync(
            "search_my_library", Args("""{"query":"quorum"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Get, handler.LastRequest!.Method);
        Assert.Equal("/me/library/search?q=quorum", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));

        var hit = Assert.Single(Body(result).GetProperty("results").EnumerateArray());
        Assert.Equal("userbook", hit.GetProperty("source").GetString());
        Assert.Equal(Book, hit.GetProperty("bookId").GetString());
        Assert.Equal("replication", hit.GetProperty("chapterSlug").GetString());
        Assert.Contains("quorum", hit.GetProperty("excerpt").GetString()!);
    }

    [Fact]
    public async Task SearchMyLibrary_NeverEmitsAnEditionId()
    {
        // The bug this surface was reported for: an upload has no editionId, so
        // inventing one would hand the model an id that 404s in ask_book.
        var (catalog, _) = BuildCatalog(Json(SearchBody));

        var result = await catalog.CallAsync(
            "search_my_library", Args("""{"query":"quorum"}"""), CancellationToken.None);

        Assert.DoesNotContain("editionId", TextOf(result));
    }

    [Fact]
    public async Task SearchMyLibrary_Tags_ArePassedThroughAsQueryParam()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"));

        await catalog.CallAsync(
            "search_my_library", Args("""{"query":"quorum","tags":"systems,work"}"""), CancellationToken.None);

        Assert.Equal("/me/library/search?q=quorum&tags=systems%2Cwork",
            handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task SearchMyLibrary_NoTags_OmitsTheParam()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"));

        await catalog.CallAsync("search_my_library", Args("""{"query":"quorum"}"""), CancellationToken.None);

        Assert.DoesNotContain("tags=", handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    [Theory]
    [InlineData("""{}""")]                                // missing query
    [InlineData("""{"query":"q"}""")]                     // shorter than minLength 2
    [InlineData("""{"query":123}""")]                     // wrong type
    [InlineData("""{"query":"quorum","x":1}""")]          // extra prop
    [InlineData("""{"query":"quorum","tags":7}""")]       // tags wrong type
    public async Task SearchMyLibrary_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("[]"));

        var result = await catalog.CallAsync("search_my_library", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SearchMyLibrary_NullToken_ReturnsAuthRequired_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"), token: null);

        var result = await catalog.CallAsync(
            "search_my_library", Args("""{"query":"quorum"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SearchMyLibrary_Api401_ReturnsAuthRequired()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.Unauthorized));

        var result = await catalog.CallAsync(
            "search_my_library", Args("""{"query":"quorum"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
    }

    // ── get_my_book ─────────────────────────────────────────────────────────────

    private const string BookBody =
        """
        {
          "id": "77777777-7777-7777-7777-777777777777",
          "title": "Designing Data-Intensive Applications",
          "slug": "designing-data-intensive-applications",
          "language": "en",
          "author": "Martin Kleppmann",
          "description": "The big ideas behind reliable systems.",
          "coverPath": null,
          "genre": "Computing",
          "publishedYear": 2017,
          "totalWordCount": 210000,
          "status": "Ready",
          "errorMessage": null,
          "hasOriginalPdf": true,
          "chapters": [
            { "id": "88888888-8888-8888-8888-888888888888", "chapterNumber": 5, "slug": "replication", "title": "Replication", "wordCount": 14200, "sourceStartPage": 151 }
          ],
          "toc": null
        }
        """;

    [Fact]
    public async Task GetMyBook_IssuesAuthorizedGet_MapsChaptersWithChapterId()
    {
        var (catalog, handler) = BuildCatalog(Json(BookBody));

        var result = await catalog.CallAsync(
            "get_my_book", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal($"/me/books/{Book}", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));

        var body = Body(result);
        Assert.Equal("userbook", body.GetProperty("source").GetString());
        Assert.Equal(Book, body.GetProperty("bookId").GetString());
        Assert.Equal("Ready", body.GetProperty("status").GetString());

        // chapterId is the whole point: save_my_highlight needs it and nothing
        // else on this surface supplies it.
        var chapter = Assert.Single(body.GetProperty("chapters").EnumerateArray());
        Assert.Equal(Chapter, chapter.GetProperty("chapterId").GetString());
        Assert.Equal("replication", chapter.GetProperty("slug").GetString());
    }

    [Fact]
    public async Task GetMyBook_ReportsWhenTheBookRendersAsAnOriginalPdf()
    {
        // Half the uploaded library is PDF, and on a PDF the reader paints highlights
        // from page geometry this bridge cannot produce. A text-anchored highlight is
        // still saved and still listed — it just never appears over the page. The
        // model has to be told that here, because the alternative is discovering it
        // by not seeing a mark it believes it made.
        var (catalog, _) = BuildCatalog(Json(BookBody));

        var result = await catalog.CallAsync(
            "get_my_book", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.True(Body(result).GetProperty("rendersAsOriginalPdf").GetBoolean());
    }

    [Fact]
    public void SaveMyHighlight_Description_WarnsAboutOriginalPdfBooks()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));
        var description = catalog.ListTools().Single(t => t.Name == "save_my_highlight").Description;

        Assert.Contains("rendersAsOriginalPdf", description);
        Assert.Contains("200 per book", description);
    }

    [Fact]
    public async Task GetMyBook_NotFound_ReturnsToolError()
    {
        // Someone else's book is a 404 (the endpoint filters by user_id), so this
        // is also the isolation path seen from the bridge.
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync(
            "get_my_book", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("no uploaded book found", TextOf(result));
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"bookId":"not-a-guid"}""")]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","x":1}""")]
    public async Task GetMyBook_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("get_my_book", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task GetMyBook_NullToken_ReturnsAuthRequired_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("{}"), token: null);

        var result = await catalog.CallAsync(
            "get_my_book", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    // ── get_my_chapter ──────────────────────────────────────────────────────────

    private const string ChapterBody =
        """
        {
          "id": "88888888-8888-8888-8888-888888888888",
          "chapterNumber": 5,
          "slug": "replication",
          "title": "Replication",
          "html": "<p>Replication means keeping a <b>copy</b> of the same data &amp; more.</p>",
          "wordCount": 11,
          "previous": { "chapterNumber": 4, "slug": "encoding", "title": "Encoding and Evolution" },
          "next": { "chapterNumber": 6, "slug": "partitioning", "title": "Partitioning" }
        }
        """;

    [Fact]
    public async Task GetMyChapter_IssuesAuthorizedGet_StripsHtml_MapsNavAndChapterId()
    {
        var (catalog, handler) = BuildCatalog(Json(ChapterBody));

        var result = await catalog.CallAsync(
            "get_my_chapter",
            Args($$"""{"bookId":"{{Book}}","chapterSlug":"replication"}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal($"/me/books/{Book}/chapters/replication", handler.LastRequest!.RequestUri!.PathAndQuery);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));

        var body = Body(result);
        Assert.Equal(Chapter, body.GetProperty("chapterId").GetString());
        Assert.Equal(Book, body.GetProperty("bookId").GetString());
        Assert.Equal("encoding", body.GetProperty("prevSlug").GetString());
        Assert.Equal("partitioning", body.GetProperty("nextSlug").GetString());
        Assert.False(body.GetProperty("truncated").GetBoolean());

        var text = body.GetProperty("text").GetString()!;
        Assert.DoesNotContain("<b>", text);
        Assert.Contains("copy", text);
        Assert.Contains("&", text); // entity decoded, not left as &amp;
    }

    [Fact]
    public async Task GetMyChapter_NotFound_ReturnsToolError()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync(
            "get_my_chapter",
            Args($$"""{"bookId":"{{Book}}","chapterSlug":"nope"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("no chapter 'nope'", TextOf(result));
    }

    [Theory]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777"}""")]  // missing slug
    [InlineData("""{"chapterSlug":"replication"}""")]                      // missing bookId
    [InlineData("""{"bookId":"nope","chapterSlug":"replication"}""")]      // bad guid
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","chapterSlug":"r","x":1}""")]
    public async Task GetMyChapter_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("get_my_chapter", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task GetMyChapter_NullToken_ReturnsAuthRequired_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("{}"), token: null);

        var result = await catalog.CallAsync(
            "get_my_chapter",
            Args($$"""{"bookId":"{{Book}}","chapterSlug":"replication"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    // ── save_my_highlight (WRITE) ───────────────────────────────────────────────

    private const string SavedHighlightBody =
        """
        {
          "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          "editionId": null, "chapterId": null,
          "userBookId": "77777777-7777-7777-7777-777777777777",
          "userChapterId": "88888888-8888-8888-8888-888888888888",
          "anchorJson": "{}", "color": "blue",
          "selectedText": "a quorum of replicas", "noteText": "the core trade-off",
          "version": 1,
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-01T00:00:00+00:00"
        }
        """;

    [Fact]
    public async Task SaveMyHighlight_PostsUserBookSideOfTheXor_NotTheEditionSide()
    {
        // The API's CreateHighlightRequest is an XOR: editionId+chapterId, or
        // userBookId+userChapterId. Sending an upload down the edition side is a 404
        // on a chapter that exists — which is the failure this whole surface is for.
        var (catalog, handler) = BuildCatalog(Json(SavedHighlightBody, HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_my_highlight",
            Args($$"""
            {"bookId":"{{Book}}","chapterId":"{{Chapter}}",
             "selectedText":"a quorum of replicas","color":"blue","noteText":"the core trade-off"}
            """),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/me/highlights", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest));

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal(Book, sent.GetProperty("userBookId").GetString());
        Assert.Equal(Chapter, sent.GetProperty("userChapterId").GetString());
        Assert.False(sent.TryGetProperty("editionId", out _));
        Assert.False(sent.TryGetProperty("chapterId", out _));
        Assert.Equal("blue", sent.GetProperty("color").GetString());

        Assert.True(Body(result).GetProperty("saved").GetBoolean());
    }

    [Fact]
    public async Task SaveMyHighlight_SynthesizesTextQuoteAnchor_FromTheExactText()
    {
        // No DOM on this side of the bridge, so the anchor is built from the quote
        // and the reader re-anchors by `exact`.
        var (catalog, handler) = BuildCatalog(Json(SavedHighlightBody, HttpStatusCode.Created));

        await catalog.CallAsync(
            "save_my_highlight",
            Args($$"""{"bookId":"{{Book}}","chapterId":"{{Chapter}}","selectedText":"a quorum of replicas"}"""),
            CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        var anchor = JsonDocument.Parse(sent.GetProperty("anchorJson").GetString()!).RootElement;
        Assert.Equal("a quorum of replicas", anchor.GetProperty("exact").GetString());
        Assert.Equal("mcp", anchor.GetProperty("source").GetString());
        Assert.Equal(Chapter, anchor.GetProperty("chapterId").GetString());
    }

    [Fact]
    public async Task SaveMyHighlight_DefaultsToYellow_WhenNoColorGiven()
    {
        var (catalog, handler) = BuildCatalog(Json(SavedHighlightBody, HttpStatusCode.Created));

        await catalog.CallAsync(
            "save_my_highlight",
            Args($$"""{"bookId":"{{Book}}","chapterId":"{{Chapter}}","selectedText":"a quorum"}"""),
            CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal("yellow", sent.GetProperty("color").GetString());
    }

    [Theory]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","selectedText":"x"}""")]
    [InlineData("""{"chapterId":"88888888-8888-8888-8888-888888888888","selectedText":"x"}""")]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","chapterId":"88888888-8888-8888-8888-888888888888"}""")]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","chapterId":"88888888-8888-8888-8888-888888888888","selectedText":"x","color":"orange"}""")]
    public async Task SaveMyHighlight_InvalidArgs_NeverWrites(string args)
    {
        // A rejected WRITE must not reach the API at all.
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("save_my_highlight", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SaveMyHighlight_NullToken_NeverWrites()
    {
        var (catalog, handler) = BuildCatalog(Json("{}"), token: null);

        var result = await catalog.CallAsync(
            "save_my_highlight",
            Args($$"""{"bookId":"{{Book}}","chapterId":"{{Chapter}}","selectedText":"x"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest);
    }

    // ── list_my_book_highlights ─────────────────────────────────────────────────

    [Fact]
    public async Task ListMyBookHighlights_UsesTheUserBookRoute_NotTheEditionRoute()
    {
        // /me/highlights/{editionId} would answer 200 with [] for a bookId — an empty
        // list that reads like "nothing highlighted" rather than "wrong route".
        var (catalog, handler) = BuildCatalog(Json($"[{SavedHighlightBody}]"));

        var result = await catalog.CallAsync(
            "list_my_book_highlights", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal($"/me/highlights/userbook/{Book}", handler.LastRequest!.RequestUri!.PathAndQuery);

        var first = Assert.Single(Body(result).GetProperty("highlights").EnumerateArray());
        Assert.Equal("a quorum of replicas", first.GetProperty("selectedText").GetString());
    }

    [Fact]
    public async Task ListMyBookHighlights_NotYourBook_SaysSo_RatherThanReturningEmpty()
    {
        // The endpoint answers 404 for a book that is not yours. An empty list is a
        // TRUTHFUL answer to "what have I highlighted", so collapsing 404 into it
        // would make a wrong bookId read as a book with no marks — which is exactly
        // the failure this whole surface exists to remove.
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync(
            "list_my_book_highlights", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("no uploaded book found", TextOf(result));
    }

    // ── save_insight ────────────────────────────────────────────────────────────

    private const string SavedInsightBody =
        """
        {
          "id": "99999999-9999-9999-9999-999999999999",
          "editionId": null,
          "userBookId": "77777777-7777-7777-7777-777777777777",
          "chapterSlug": "replication", "chapterNumber": null, "chapterTitle": null,
          "text": "Quorums are about overlap, not majorities.",
          "question": "why w + r > n?",
          "source": "mcp",
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-02T00:00:00+00:00"
        }
        """;

    [Fact]
    public async Task SaveInsight_PostsChapterScopedInsight_WithItsQuestion()
    {
        var (catalog, handler) = BuildCatalog(Json(SavedInsightBody, HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_insight",
            Args($$"""
            {"bookId":"{{Book}}","chapterSlug":"replication",
             "text":"Quorums are about overlap, not majorities.","question":"why w + r > n?"}
            """),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/me/insights", handler.LastRequest.RequestUri!.PathAndQuery);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal(Book, sent.GetProperty("userBookId").GetString());
        Assert.Equal("replication", sent.GetProperty("chapterSlug").GetString());
        Assert.Equal("why w + r > n?", sent.GetProperty("question").GetString());
        Assert.False(sent.TryGetProperty("editionId", out _));

        Assert.True(Body(result).GetProperty("saved").GetBoolean());
    }

    [Fact]
    public async Task SaveInsight_NoChapterSlug_MeansTheWholeBook()
    {
        // The book-level insight IS the конспект's overview, so its absence of a
        // chapter must survive the wire rather than becoming an empty string.
        var (catalog, handler) = BuildCatalog(Json(SavedInsightBody, HttpStatusCode.Created));

        await catalog.CallAsync(
            "save_insight",
            Args($$"""{"bookId":"{{Book}}","text":"The book's argument in one paragraph."}"""),
            CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.False(sent.TryGetProperty("chapterSlug", out _));
    }

    [Theory]
    [InlineData("""{"text":"x"}""")]                                          // neither target
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","editionId":"33333333-3333-3333-3333-333333333333","text":"x"}""")] // both
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777"}""")]     // no text
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777","text":"x","x":1}""")]
    public async Task SaveInsight_InvalidTargetOrArgs_NeverWrites(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync("save_insight", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SaveInsight_BothTargets_SaysWhichToPick()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));

        var result = await catalog.CallAsync(
            "save_insight",
            Args($$"""{"bookId":"{{Book}}","editionId":"33333333-3333-3333-3333-333333333333","text":"x"}"""),
            CancellationToken.None);

        Assert.Contains("not both", TextOf(result));
    }

    // ── get_my_insights ─────────────────────────────────────────────────────────

    [Fact]
    public async Task GetMyInsights_ByBookId_MapsChapterPlacementAndQuestion()
    {
        const string body =
            """
            [
              {
                "id": "99999999-9999-9999-9999-999999999999",
                "editionId": null, "userBookId": "77777777-7777-7777-7777-777777777777",
                "chapterSlug": null, "chapterNumber": null, "chapterTitle": null,
                "text": "The book's argument in one paragraph.",
                "question": "what is this book actually about?",
                "source": "mcp",
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-02T00:00:00+00:00"
              },
              {
                "id": "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa",
                "editionId": null, "userBookId": "77777777-7777-7777-7777-777777777777",
                "chapterSlug": "replication", "chapterNumber": 5, "chapterTitle": "Replication",
                "text": "Quorums are about overlap, not majorities.",
                "question": "why w + r > n?",
                "source": "mcp",
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-02T00:00:00+00:00"
              }
            ]
            """;
        var (catalog, handler) = BuildCatalog(Json(body));

        var result = await catalog.CallAsync(
            "get_my_insights", Args($$"""{"bookId":"{{Book}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal($"/me/insights?userBookId={Book}", handler.LastRequest!.RequestUri!.PathAndQuery);

        var items = Body(result).GetProperty("insights").EnumerateArray().ToArray();
        Assert.Equal(2, items.Length);
        // Book-level first — it is the overview, and the server orders it that way.
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("chapterSlug").ValueKind);
        Assert.Equal("Replication", items[1].GetProperty("chapterTitle").GetString());
        Assert.Equal("why w + r > n?", items[1].GetProperty("question").GetString());
    }

    [Fact]
    public async Task GetMyInsights_ByEditionId_UsesTheEditionQueryParam()
    {
        const string edition = "33333333-3333-3333-3333-333333333333";
        var (catalog, handler) = BuildCatalog(Json("[]"));

        await catalog.CallAsync(
            "get_my_insights", Args($$"""{"editionId":"{{edition}}"}"""), CancellationToken.None);

        Assert.Equal($"/me/insights?editionId={edition}", handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    [Theory]
    [InlineData("""{"bookId":"77777777-7777-7777-7777-777777777777"}""", "no uploaded book found")]
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333"}""", "no catalog book found")]
    public async Task GetMyInsights_UnknownBook_SaysSo_RatherThanReturningEmpty(string args, string expected)
    {
        // Same trap as list_my_book_highlights: "you have not discussed this book" and
        // "that is not your book" are different answers, and only one of them is worth
        // acting on.
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync("get_my_insights", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains(expected, TextOf(result));
    }

    [Fact]
    public async Task GetMyInsights_NoTarget_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("[]"));

        var result = await catalog.CallAsync("get_my_insights", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    // ── the two search tools must stay distinguishable ──────────────────────────

    [Fact]
    public void SearchDescriptions_NameWhichHalfOfTheLibraryTheySearch()
    {
        // Two tools whose names differ by "_my_" is not enough for a model to pick
        // correctly under pressure; the descriptions have to say it.
        var (catalog, _) = BuildCatalog(Json("{}"));
        var byName = catalog.ListTools().ToDictionary(t => t.Name);

        Assert.Contains("PUBLIC", byName["search_books"].Description);
        Assert.Contains("search_my_library", byName["search_books"].Description);
        Assert.Contains("UPLOADED", byName["search_my_library"].Description);
        Assert.Contains("NOT an editionId", byName["search_my_library"].Description);
    }
}
