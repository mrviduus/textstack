using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// AI-053 — over-the-wire MCP integration tests. The REAL <see cref="McpClient"/>
/// drives the REAL <c>BuildHttp</c> host (<c>MapMcp("/mcp")</c>, streamable HTTP,
/// SDK JSON-RPC framing) through the full protocol — initialize → tools/list →
/// tools/call — for all 7 tools, a one-session e2e, the negative paths, and the
/// spoiler gate. Backed by a recording <see cref="StubBackend"/>; the tests assert
/// BOTH the mapped MCP result AND that the bridge issued the right upstream call
/// (method / path+query / Bearer).
///
/// Hermetic: loopback only (no Docker, no live API, no external network). References
/// only the bridge under test → zero ITool in this assembly. The AI-047..050 unit tests use fake HttpMessageHandlers and
/// never exercise the SDK wire — this suite closes that gap.
/// </summary>
public class McpOverTheWireTests : IAsyncLifetime
{
    private McpServerHarness _harness = null!;

    public async ValueTask InitializeAsync() =>
        _harness = await McpServerHarness.StartAsync(TestContext.Current.CancellationToken);

    public async ValueTask DisposeAsync() => await _harness.DisposeAsync();

    private CancellationToken Ct => TestContext.Current.CancellationToken;

    // ── helpers ──────────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> Args(params (string Key, object? Value)[] pairs)
    {
        var d = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (k, v) in pairs)
            d[k] = v;
        return d;
    }

    private static string TextOf(CallToolResult result) => ((TextContentBlock)result.Content[0]).Text;

    private static JsonElement Json(CallToolResult result) => JsonDocument.Parse(TextOf(result)).RootElement;

    /// <summary>Asserts the call succeeded, and puts the tool's own message in the failure.</summary>
    private static void AssertOk(CallToolResult result) =>
        Assert.False(result.IsError == true, TextOf(result));

    private async Task<CallToolResult> CallAsync(McpClient client, string tool, Dictionary<string, object?> args) =>
        await client.CallToolAsync(tool, args!, cancellationToken: Ct);

    // ── 1. search_books (public, no Bearer) ───────────────────────────────────────

    [Fact]
    public async Task SearchBooks_OverWire_ReturnsDraculaHit_AndStubSawPublicGet()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "search_books", Args(("query", "dracula"), ("limit", 5)));

        Assert.NotEqual(true, result.IsError);
        var first = Assert.Single(Json(result).GetProperty("results").EnumerateArray());
        Assert.Equal("Dracula", first.GetProperty("title").GetString());
        Assert.Equal("Bram Stoker", first.GetProperty("author").GetString());
        Assert.Equal("dracula", first.GetProperty("editionSlug").GetString());

        var req = _harness.Stub.Last("search");
        Assert.NotNull(req);
        Assert.Equal("GET", req!.Method);
        Assert.Equal("/search?q=dracula&limit=5", req.PathAndQuery);
        Assert.Null(req.Authorization); // public → no bearer
        Assert.Equal("textstack.app", req.Host);
    }

    // ── 2. get_book (public, maps editionId) ──────────────────────────────────────

    [Fact]
    public async Task GetBook_OverWire_MapsEditionId_AndStubSawPublicGet()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_book", Args(("slug", "dracula")));

        Assert.NotEqual(true, result.IsError);
        var root = Json(result);
        Assert.Equal(StubBackend.GoodEdition, root.GetProperty("editionId").GetString());
        Assert.Equal("Dracula", root.GetProperty("title").GetString());
        Assert.Equal("Bram Stoker", root.GetProperty("authors")[0].GetString());
        Assert.Equal(2, root.GetProperty("chapters").GetArrayLength());

        var req = _harness.Stub.Last("get_book");
        Assert.Equal("GET", req!.Method);
        Assert.Equal("/books/dracula", req.PathAndQuery);
        Assert.Null(req.Authorization);
    }

    // ── 3. get_chapter (public, HTML stripped) ────────────────────────────────────

    [Fact]
    public async Task GetChapter_OverWire_StripsHtml_AndStubSawPublicGet()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_chapter", Args(("slug", "dracula"), ("chapterSlug", "ch-1")));

        Assert.NotEqual(true, result.IsError);
        var root = Json(result);
        Assert.Equal(1, root.GetProperty("chapterNumber").GetInt32());
        Assert.Equal("ch-2", root.GetProperty("nextSlug").GetString());
        // Tags stripped, &mdash; decoded, whitespace collapsed. (Inline-element
        // boundaries become spaces — pin the bridge's HtmlText.StripAndCap output.)
        Assert.Equal("3 May. Bistritz . — Left Munich at 8:35 P.M.", root.GetProperty("text").GetString());

        var req = _harness.Stub.Last("get_chapter");
        Assert.Equal("/books/dracula/chapters/ch-1", req!.PathAndQuery);
        Assert.Null(req.Authorization);
    }

    // ── 4. list_my_highlights (Bearer) ────────────────────────────────────────────

    [Fact]
    public async Task ListMyHighlights_OverWire_ForwardsBearer_MapsFields()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "list_my_highlights", Args(("editionId", StubBackend.GoodEdition)));

        Assert.NotEqual(true, result.IsError);
        var first = Assert.Single(Json(result).GetProperty("highlights").EnumerateArray());
        Assert.Equal("the dead travel fast", first.GetProperty("selectedText").GetString());

        var req = _harness.Stub.Last("list_my_highlights");
        Assert.Equal("GET", req!.Method);
        Assert.Equal($"/me/highlights/{StubBackend.GoodEdition}", req.PathAndQuery);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", req.Authorization);
    }

    // ── 5. list_my_vocabulary (Bearer) ────────────────────────────────────────────

    [Fact]
    public async Task ListMyVocabulary_OverWire_ForwardsBearer_MapsPage()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "list_my_vocabulary", Args());

        Assert.NotEqual(true, result.IsError);
        var root = Json(result);
        Assert.Equal(1, root.GetProperty("total").GetInt32());
        Assert.Equal("crepuscular", root.GetProperty("items")[0].GetProperty("word").GetString());

        var req = _harness.Stub.Last("list_my_vocabulary");
        Assert.Equal("/me/vocabulary/words", req!.PathAndQuery);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", req.Authorization);
    }

    // ── 6. save_highlight (Bearer, WRITE, synthesized anchor in body) ─────────────

    [Fact]
    public async Task SaveHighlight_OverWire_ForwardsBearer_PostsSynthesizedAnchor_Returns201()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "save_highlight", Args(
            ("editionId", StubBackend.GoodEdition),
            ("chapterId", StubBackend.ChapterId),
            ("selectedText", "Listen to them, the children of the night"),
            ("color", "green"),
            ("noteText", "famous line")));

        Assert.NotEqual(true, result.IsError);
        var root = Json(result);
        Assert.Equal(StubBackend.NewHighlightId, root.GetProperty("id").GetString());
        Assert.True(root.GetProperty("saved").GetBoolean());

        var req = _harness.Stub.Last("save_highlight");
        Assert.Equal("POST", req!.Method);
        Assert.Equal("/me/highlights", req.PathAndQuery);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", req.Authorization);

        // The bridge forwarded every agent-provided field on the POST body…
        var sent = JsonDocument.Parse(req.Body).RootElement;
        Assert.Equal(StubBackend.GoodEdition, sent.GetProperty("editionId").GetString());
        Assert.Equal(StubBackend.ChapterId, sent.GetProperty("chapterId").GetString());
        Assert.Equal("green", sent.GetProperty("color").GetString());
        Assert.Equal("Listen to them, the children of the night", sent.GetProperty("selectedText").GetString());
        Assert.Equal("famous line", sent.GetProperty("noteText").GetString());
        // …and synthesized a W3C text-quote anchor server-side (no DOM client): exact =
        // the selection, source = "mcp", and chapterId carried into the anchor too.
        var anchor = JsonDocument.Parse(sent.GetProperty("anchorJson").GetString()!).RootElement;
        Assert.Equal("Listen to them, the children of the night", anchor.GetProperty("exact").GetString());
        Assert.Equal("mcp", anchor.GetProperty("source").GetString());
        Assert.Equal(StubBackend.ChapterId, anchor.GetProperty("chapterId").GetString());
    }

    // ── 8. protocol: initialize → serverInfo ──────────────────────────────────────

    [Fact]
    public async Task Initialize_OverWire_ServerInfoNameIsTextstack()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        Assert.Equal("textstack", client.ServerInfo.Name);
    }

    [Fact]
    public async Task Initialize_OverWire_ReturnsServerInstructionsNamingTheWorkflowTools()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var instructions = client.ServerInstructions;
        Assert.False(string.IsNullOrWhiteSpace(instructions));
        foreach (var tool in new[] { "search_my_library", "get_my_insights", "save_insight", "get_chapter_review", "save_chapter_review", "add_vocabulary_words" })
            Assert.Contains(tool, instructions);
    }

    // ── 9. protocol: tools/list → exactly the advertised surface ─────────────────

    [Fact]
    public async Task ListTools_OverWire_ReturnsExactlyTheExpectedTools()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var tools = await client.ListToolsAsync(cancellationToken: Ct);

        var names = tools.Select(t => t.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        Assert.Equal(
            ["add_vocabulary_words", "delete_vocabulary_word", "get_book", "get_book_progress", "get_chapter", "get_chapter_review", "get_my_book", "get_my_chapter", "get_my_insights", "get_my_reading", "list_my_book_highlights", "list_my_highlights", "list_my_vocabulary", "save_chapter_review", "save_highlight", "save_insight", "save_my_highlight", "search_books", "search_my_library", "set_book_progress", "update_vocabulary_word"],
            names);
    }

    // ── 9b. directory review: every tool carries a title and honest hints ──────────

    [Fact]
    public async Task ListTools_OverWire_EveryToolHasTitleAndHints_WritesAreNotReadOnly()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var tools = (await client.ListToolsAsync(cancellationToken: Ct)).Select(t => t.ProtocolTool).ToList();

        string[] writes = ["save_highlight", "save_my_highlight", "save_insight", "save_chapter_review", "set_book_progress", "add_vocabulary_words", "update_vocabulary_word", "delete_vocabulary_word"];
        foreach (var tool in tools)
        {
            Assert.False(string.IsNullOrWhiteSpace(tool.Title), tool.Name);
            var a = tool.Annotations;
            Assert.NotNull(a);
            Assert.Equal(tool.Title, a!.Title);
            Assert.Equal(!writes.Contains(tool.Name), a.ReadOnlyHint);
            Assert.False(a.OpenWorldHint);
            Assert.NotNull(a.DestructiveHint);
            if (a.ReadOnlyHint == true) Assert.False(a.DestructiveHint);
        }
        Assert.True(tools.Single(t => t.Name == "save_insight").Annotations!.DestructiveHint); // replaces on re-save
        Assert.False(tools.Single(t => t.Name == "save_highlight").Annotations!.DestructiveHint); // only adds
    }

    // ── 10. negative: NO bearer → HTTP 401 + OAuth challenge, zero upstream hits ──

    private async Task<HttpResponseMessage> PostInitializeAsync(string? authorization)
    {
        using var http = new HttpClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, _harness.McpEndpoint)
        {
            Content = new StringContent(
                """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}""",
                System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Accept.ParseAdd("application/json");
        req.Headers.Accept.ParseAdd("text/event-stream");
        if (authorization is not null) req.Headers.TryAddWithoutValidation("Authorization", authorization);
        return await http.SendAsync(req, Ct);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Bearer ")]
    [InlineData("Basic dXNlcjpwYXNz")]
    public async Task Mcp_NoBearer_Returns401WithResourceMetadataChallenge(string? authorization)
    {
        using var resp = await PostInitializeAsync(authorization);

        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, resp.StatusCode);
        var challenge = Assert.Single(resp.Headers.WwwAuthenticate);
        Assert.Equal("Bearer", challenge.Scheme);
        Assert.Contains(
            "resource_metadata=\"https://textstack.app/.well-known/oauth-protected-resource/mcp\"",
            challenge.Parameter);
        Assert.DoesNotContain("error=", challenge.Parameter); // no credentials sent → no error code (RFC 6750 §3.1)
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    [Fact]
    public async Task Mcp_WithBearer_Initializes()
    {
        using var resp = await PostInitializeAsync($"Bearer {McpServerHarness.TestJwt}");

        Assert.Equal(System.Net.HttpStatusCode.OK, resp.StatusCode);
    }

    [Theory]
    [InlineData("/.well-known/oauth-protected-resource/mcp")]
    [InlineData("/.well-known/oauth-protected-resource")]
    public async Task ProtectedResourceMetadata_BothPaths_ServeTheSameDocument(string path)
    {
        using var http = new HttpClient();
        var origin = _harness.McpEndpoint[..^"/mcp".Length];

        using var resp = await http.GetAsync(origin + path, Ct);

        Assert.Equal(System.Net.HttpStatusCode.OK, resp.StatusCode);
        var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(Ct)).RootElement;
        Assert.Equal("https://textstack.app/mcp", doc.GetProperty("resource").GetString());
        Assert.Equal("https://textstack.app", Assert.Single(doc.GetProperty("authorization_servers").EnumerateArray()).GetString());
        Assert.Contains(doc.GetProperty("scopes_supported").EnumerateArray(), s => s.GetString() == "offline_access");
    }

    [Fact]
    public async Task Mcp_ExpiredOAuthToken_Returns401InvalidToken_SoTheClientRefreshes()
    {
        using var resp = await PostInitializeAsync($"Bearer {StubBackend.RejectedOAuthToken}");

        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, resp.StatusCode);
        Assert.Contains("error=\"invalid_token\"", Assert.Single(resp.Headers.WwwAuthenticate).Parameter);
    }

    [Fact]
    public async Task Mcp_LiveOAuthToken_Initializes()
    {
        using var resp = await PostInitializeAsync($"Bearer {StubBackend.LiveOAuthToken}");

        Assert.Equal(System.Net.HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal($"Bearer {StubBackend.LiveOAuthToken}", _harness.Stub.Last("token_status")!.Authorization);
    }

    // ── 10b. personal connect URL (/mcp/k/<key>) — how ChatGPT connects ─────────────

    private const string UrlKey = "tsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

    [Fact]
    public async Task ConnectUrl_NoHeader_KeyInPath_ForwardedAsBearer()
    {
        await using var client = await _harness.ConnectViaUrlAsync(UrlKey, Ct);

        var result = await CallAsync(client, "list_my_highlights", Args(("editionId", StubBackend.GoodEdition)));

        AssertOk(result);
        Assert.Equal($"Bearer {UrlKey}", _harness.Stub.Last("list_my_highlights")!.Authorization);
    }

    [Theory]
    [InlineData("tsk_short")]                                          // wrong length
    [InlineData("jwt-abc.def.ghi")]                                    // not a connect key
    [InlineData("tsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcde")]   // plain base64, not base64url
    public async Task ConnectUrl_MalformedKey_404_NeverReachesMcp(string key)
    {
        using var http = new HttpClient();
        using var resp = await http.PostAsync($"{_harness.McpEndpoint}/k/{Uri.EscapeDataString(key)}",
            new StringContent("{}", System.Text.Encoding.UTF8, "application/json"), Ct);

        Assert.Equal(System.Net.HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    // ── 11. negative: invalid args (missing required) → IsError, no upstream call ──

    [Fact]
    public async Task SearchBooks_MissingQuery_OverWire_ToolError_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "search_books", Args());

        Assert.True(result.IsError);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    // ── 12. negative: upstream non-JSON 200 → clean IsError, NOT a protocol fault ──

    [Fact]
    public async Task GetBook_UpstreamUnreachable_OverWire_CleanToolError_NotProtocolFault()
    {
        // Point a fresh harness's bridge at an unreachable upstream → the transport
        // failure surfaces as a clean "upstream unavailable" tool IsError (the bridge's
        // shared wrapper), NOT a JSON-RPC -32603 protocol fault that would break the
        // SDK call. Proves the wire protocol stays intact on backend failure.
        await using var broken = await McpServerHarness.StartWithUnreachableUpstreamAsync(Ct);
        await using var client = await broken.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "get_book", new Dictionary<string, object?> { ["slug"] = "dracula" }!, cancellationToken: Ct);

        Assert.True(result.IsError);
        Assert.Contains("get_book failed", TextOf(result));
        // Must NOT leak internals to the model.
        Assert.DoesNotContain("Exception", TextOf(result));
    }

    // ── 13. one-session e2e: ONE initialize → list → get_chapter → save → ask ─────

    [Fact]
    public async Task OneSession_OverWire_ListAndSave_AllSucceed()
    {
        // A single client (one initialize handshake) exercises the DoD path:
        // "list chapters, save highlight, ask, one session".
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var tools = await client.ListToolsAsync(cancellationToken: Ct);
        Assert.Equal(21, tools.Count);

        var chapter = await CallAsync(client, "get_chapter", Args(("slug", "dracula"), ("chapterSlug", "ch-1")));
        Assert.NotEqual(true, chapter.IsError);

        var saved = await CallAsync(client, "save_highlight", Args(
            ("editionId", StubBackend.GoodEdition),
            ("chapterId", StubBackend.ChapterId),
            ("selectedText", "the dead travel fast")));
        Assert.NotEqual(true, saved.IsError);
        Assert.True(Json(saved).GetProperty("saved").GetBoolean());

        // The user-scoped call forwarded the session bearer.
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("save_highlight")!.Authorization);
    }

    // ── 14. one-session e2e over the UPLOADED half: search → book → chapter ───────

    [Fact]
    public async Task OneSession_OverWire_MyLibraryChain_SearchToBookToChapter()
    {
        // The chain a client actually walks to work with a user's own upload, in
        // one session: find the book, list its chapters, read one. Every step is
        // keyed by bookId; nothing in the chain produces or consumes an editionId.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var found = await CallAsync(client, "search_my_library", Args(("query", "quorum")));
        Assert.NotEqual(true, found.IsError);
        var hit = Json(found).GetProperty("results").EnumerateArray().Single();
        Assert.Equal("userbook", hit.GetProperty("source").GetString());
        var bookId = hit.GetProperty("bookId").GetString()!;
        Assert.Equal(StubBackend.UserBookId, bookId);

        var book = await CallAsync(client, "get_my_book", Args(("bookId", bookId)));
        Assert.NotEqual(true, book.IsError);
        var chapter = Json(book).GetProperty("chapters").EnumerateArray().Single();
        Assert.Equal(StubBackend.UserChapterId, chapter.GetProperty("chapterId").GetString());

        var read = await CallAsync(client, "get_my_chapter", Args(
            ("bookId", bookId),
            ("chapterSlug", chapter.GetProperty("slug").GetString())));
        Assert.NotEqual(true, read.IsError);
        Assert.Contains("Replication means keeping a copy", Json(read).GetProperty("text").GetString());

        // The chain never mentions an editionId — an upload does not have one, and
        // a plausible-looking id here is worse than none.
        Assert.DoesNotContain("editionId", TextOf(found));
        Assert.DoesNotContain("editionId", TextOf(book));
        Assert.DoesNotContain("editionId", TextOf(read));

        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("search_my_library")!.Authorization);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("get_my_chapter")!.Authorization);
    }

    // ── 15. one-session e2e: the write-back loop ─────────────────────────────────

    [Fact]
    public async Task OneSession_OverWire_WriteBack_HighlightThenInsightThenReadBack()
    {
        // The point of the whole surface: an outside assistant finishes a reading
        // session by marking a passage and writing its conclusion into the book, and
        // the NEXT session reads that back instead of starting over.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var highlighted = await CallAsync(client, "save_my_highlight", Args(
            ("bookId", StubBackend.UserBookId),
            ("chapterId", StubBackend.UserChapterId),
            ("selectedText", "a quorum of replicas"),
            ("color", "blue")));
        Assert.NotEqual(true, highlighted.IsError);

        // It went down the user-book side of the API's XOR, not the edition side.
        var sent = JsonDocument.Parse(_harness.Stub.Last("save_highlight")!.Body).RootElement;
        Assert.Equal(StubBackend.UserBookId, sent.GetProperty("userBookId").GetString());
        Assert.False(sent.TryGetProperty("editionId", out _));

        var saved = await CallAsync(client, "save_insight", Args(
            ("bookId", StubBackend.UserBookId),
            ("chapterSlug", "replication"),
            ("text", "Quorums are about overlap, not majorities."),
            ("question", "why w + r > n?")));
        Assert.NotEqual(true, saved.IsError);
        Assert.True(Json(saved).GetProperty("saved").GetBoolean());

        // A later session picks the book back up and finds the work already done.
        var back = await CallAsync(client, "get_my_insights", Args(("bookId", StubBackend.UserBookId)));
        Assert.NotEqual(true, back.IsError);
        var items = Json(back).GetProperty("insights").EnumerateArray().ToArray();
        Assert.Equal(2, items.Length);
        Assert.Contains(items, i => i.GetProperty("chapterTitle").GetString() == "Replication");

        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("save_insight")!.Authorization);
    }

    // ── 15. reading state: the shelf, the position, and moving it ─────────────────

    [Fact]
    public async Task GetMyReading_OverWire_ReturnsBothBookKinds_WithTitlesAndTheIdsTheOtherToolsTake()
    {
        // The whole reason this tool exists: with no arguments it is the only way into everything
        // else, so it has to hand back an id each other tool actually accepts — a bookId for an
        // upload, an editionId AND a slug for a catalog book. Handing back the wrong one reads as
        // "book not found" three calls later, far from the cause.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_my_reading", Args());

        AssertOk(result);
        var reading = Json(result).GetProperty("reading").EnumerateArray().ToArray();
        Assert.Equal(2, reading.Length);

        var upload = reading.Single(r => r.GetProperty("source").GetString() == "userbook");
        Assert.Equal("Designing Data-Intensive Applications", upload.GetProperty("title").GetString());
        Assert.Equal(StubBackend.UserBookId, upload.GetProperty("bookId").GetString());
        Assert.Equal(JsonValueKind.Null, upload.GetProperty("editionId").ValueKind);
        Assert.Equal("replication", upload.GetProperty("chapterSlug").GetString());

        var catalog = reading.Single(r => r.GetProperty("source").GetString() == "savedbook");
        Assert.Equal(StubBackend.GoodEdition, catalog.GetProperty("editionId").GetString());
        Assert.Equal("dracula", catalog.GetProperty("slug").GetString());
        Assert.Equal(JsonValueKind.Null, catalog.GetProperty("bookId").ValueKind);

        // The shelf is capped and filtered to in-progress, so a book never opened appears only here.
        var all = Json(result).GetProperty("allBooks").EnumerateArray().ToArray();
        Assert.Equal(2, all.Length);
        Assert.Contains(all, b => b.GetProperty("title").GetString() == "The Mom Test");
    }

    [Fact]
    public async Task GetBookProgress_OverWire_UploadAndCatalog_ReportWhereTheReaderStopped()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var upload = await CallAsync(client, "get_book_progress", Args(("bookId", StubBackend.UserBookId)));
        AssertOk(upload);
        Assert.True(Json(upload).GetProperty("opened").GetBoolean());
        Assert.Equal("replication", Json(upload).GetProperty("chapterSlug").GetString());

        var catalog = await CallAsync(client, "get_book_progress", Args(("editionId", StubBackend.GoodEdition)));
        AssertOk(catalog);
        Assert.Equal("ch-1", Json(catalog).GetProperty("chapterSlug").GetString());
        Assert.Equal($"/me/progress/{StubBackend.GoodEdition}", _harness.Stub.Last("get_edition_progress")!.PathAndQuery);
    }

    [Fact]
    public async Task GetBookProgress_NeverOpened_OverWire_SaysNotStarted_NotAnError()
    {
        // 404 here means "this reader has not opened this book", which is an answer. Reporting it as
        // a failure would have the model tell a reader their library is broken.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_book_progress", Args(("editionId", StubBackend.UnopenedEdition)));

        AssertOk(result);
        Assert.False(Json(result).GetProperty("opened").GetBoolean());
    }

    [Fact]
    public async Task GetBookProgress_BothIds_OverWire_Refused_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_book_progress",
            Args(("bookId", StubBackend.UserBookId), ("editionId", StubBackend.GoodEdition)));

        Assert.True(result.IsError);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    [Fact]
    public async Task SetBookProgress_CatalogMidBook_OverWire_ResumesAtTheNextChapter_WithABookWidePercent()
    {
        // "I finished chapter 1" must not drop the reader back into chapter 1. The stored position
        // becomes the START of chapter 2 — the app's own markAsUnread sentinel — and the percentage
        // is chapters-done over chapters-total, declared as a BOOK fraction because a number without
        // a declared unit is silently discarded (ProgressUnit).
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress", Args(("slug", "dracula"), ("chapterSlug", "ch-1")));

        AssertOk(result);
        Assert.Equal("ch-2", Json(result).GetProperty("resumeChapterSlug").GetString());
        Assert.False(Json(result).GetProperty("bookFinished").GetBoolean());

        var put = _harness.Stub.Last("set_edition_progress")!;
        Assert.Equal("PUT", put.Method);
        var body = JsonDocument.Parse(put.Body).RootElement;
        Assert.Equal("66666666-6666-6666-6666-666666666666", body.GetProperty("chapterId").GetString());
        Assert.Equal("{\"type\":\"start\"}", body.GetProperty("locator").GetString());
        Assert.Equal(0.5, body.GetProperty("percent").GetDouble());
        Assert.Equal("book", body.GetProperty("percentUnit").GetString());
    }

    [Fact]
    public async Task SetBookProgress_CatalogLastChapter_OverWire_MarksTheBookFinished()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress", Args(("slug", "dracula"), ("chapterSlug", "ch-2")));

        AssertOk(result);
        Assert.True(Json(result).GetProperty("bookFinished").GetBoolean());

        var body = JsonDocument.Parse(_harness.Stub.Last("set_edition_progress")!.Body).RootElement;
        // The app's own mark-as-read sentinel, and the 1.0 the server turns into CompletedAt.
        Assert.Equal("{\"type\":\"end\"}", body.GetProperty("locator").GetString());
        Assert.Equal(1d, body.GetProperty("percent").GetDouble());
    }

    [Fact]
    public async Task SetBookProgress_Upload_OverWire_WritesAScrollLocator_AndDeclaresTheSpace()
    {
        // Uploads are slug-native, and the locator has to stay in the coordinate space the reader's
        // own app writes. The declared kind is what lets the write land on a book last read as an
        // Original-layout PDF, whose stored position is `page:<n>` — LocatorSpace.MayReplace drops
        // an undeclared cross-space write whole.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication")));

        AssertOk(result);
        var body = JsonDocument.Parse(_harness.Stub.Last("set_my_book_progress")!.Body).RootElement;
        Assert.Equal("replication", body.GetProperty("chapterSlug").GetString());
        Assert.Equal("scroll:replication:0", body.GetProperty("locator").GetString());
        Assert.Equal("scroll", body.GetProperty("locatorKind").GetString());
        Assert.Equal("book", body.GetProperty("percentUnit").GetString());
    }

    [Fact]
    public async Task SetBookProgress_UnknownChapter_OverWire_Refused_WithoutWritingAnything()
    {
        // The defect this closes: an invented slug used to be stored verbatim, and every later read
        // resolved it to nothing. The tool must refuse before the write, not after.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress",
            Args(("slug", "dracula"), ("chapterSlug", "ch-99")));

        Assert.True(result.IsError);
        Assert.Contains("no chapter 'ch-99'", TextOf(result));
        Assert.Null(_harness.Stub.Last("set_edition_progress"));
    }

    [Fact]
    public async Task SetBookProgress_UpstreamRefusal_OverWire_ReportsFailure_NotSuccess()
    {
        // The other half of the same defect, on the server side: MayReplace used to answer (true,
        // null), so the API returned 200 having stored nothing and an assistant told a person their
        // progress was recorded. A non-2xx must surface as a tool error.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress",
            Args(("bookId", StubBackend.RefusingBookId), ("chapterSlug", "replication")));

        Assert.True(result.IsError);
        Assert.Contains("refused", TextOf(result));
    }

    [Fact]
    public async Task SetBookProgress_BothBookIdAndSlug_OverWire_Refused_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "set_book_progress",
            Args(("bookId", StubBackend.UserBookId), ("slug", "dracula"), ("chapterSlug", "replication")));

        Assert.True(result.IsError);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    // ── chapter review ───────────────────────────────────────────────────────────

    [Fact]
    public async Task GetChapterReview_OverWire_ReturnsTheApiDtoUnchanged_AndForwardsPart()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var first = await CallAsync(client, "get_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication")));
        AssertOk(first);
        var body = Json(first);
        Assert.Equal(2, body.GetProperty("chapter").GetProperty("partCount").GetInt32());
        Assert.Equal("save_chapter_review", body.GetProperty("saveWith").GetString());
        // Non-ASCII reaches the model as itself, not as — — six characters per letter otherwise.
        Assert.Contains("review — method", TextOf(first));
        var sent = _harness.Stub.Last("get_chapter_review")!;
        Assert.Contains($"userBookId={StubBackend.UserBookId}", sent.PathAndQuery);
        Assert.Contains("chapterSlug=replication", sent.PathAndQuery);
        Assert.DoesNotContain("part=", sent.PathAndQuery);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", sent.Authorization);

        var second = await CallAsync(client, "get_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication"), ("part", 2)));
        AssertOk(second);
        Assert.Equal(2, Json(second).GetProperty("chapter").GetProperty("part").GetInt32());
        Assert.Contains("part=2", _harness.Stub.Last("get_chapter_review")!.PathAndQuery);
    }

    [Fact]
    public async Task GetChapterReview_ChapterNotReached_OverWire_RelaysTheServerInstruction()
    {
        // The spoiler gate's message is the whole point of the refusal: it tells the model to confirm
        // with the reader and call set_book_progress. Collapsed into "not found" it would be useless.
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", StubBackend.NotReachedSlug)));

        Assert.True(result.IsError);
        Assert.Contains("set_book_progress", TextOf(result));
    }

    [Fact]
    public async Task GetChapterReview_PartOutOfRange_OverWire_Refused_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "get_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication"), ("part", 21)));

        Assert.True(result.IsError);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    [Fact]
    public async Task SaveChapterReview_Refused_OverWire_ErrorTextContainsEveryPath()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);
        var review = JsonDocument.Parse("""{ "blocks": [ { "title": "x" } ], "applications": ["y"] }""").RootElement;

        var result = await CallAsync(client, "save_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication"), ("review", review)));

        Assert.True(result.IsError);
        var text = TextOf(result);
        Assert.Contains("fix all of them", text);
        Assert.Contains("blocks: must have 3–6 blocks", text);
        Assert.Contains("blocks[0].rootCause: must be one line", text);
    }

    [Fact]
    public async Task SaveChapterReview_Valid_OverWire_ForwardsReviewUntouched_AndReturnsSaved()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);
        var review = JsonDocument.Parse("""{ "blocks": [ {}, {}, {} ], "applications": ["y"], "extra": 1 }""").RootElement;

        var result = await CallAsync(client, "save_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication"), ("review", review)));

        AssertOk(result);
        Assert.True(Json(result).GetProperty("saved").GetBoolean());
        var sent = JsonDocument.Parse(_harness.Stub.Last("save_chapter_review")!.Body).RootElement;
        Assert.Equal(StubBackend.UserBookId, sent.GetProperty("userBookId").GetString());
        Assert.Equal("replication", sent.GetProperty("chapterSlug").GetString());
        // The bridge is not a validator: even an unknown key reaches the server, which names it.
        Assert.Equal(1, sent.GetProperty("review").GetProperty("extra").GetInt32());
    }

    [Fact]
    public async Task SaveChapterReview_ReviewNotAnObject_OverWire_Refused_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "save_chapter_review",
            Args(("bookId", StubBackend.UserBookId), ("chapterSlug", "replication"), ("review", "text")));

        Assert.True(result.IsError);
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    // ── vocabulary writes: add → update → delete over the wire ────────────────────

    [Fact]
    public async Task VocabularyWrites_OverWire_AddUpdateDelete_AllSucceed()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);
        const string id = "55555555-5555-5555-5555-555555555555";
        var words = JsonDocument.Parse("""[{ "word": "crepuscular", "language": "en", "translation": "сутінковий" }]""").RootElement;

        var added = await CallAsync(client, "add_vocabulary_words",
            Args(("words", words), ("bookId", StubBackend.UserBookId)));
        AssertOk(added);
        var line = Json(added).GetProperty("results")[0];
        Assert.Equal("srs", line.GetProperty("status").GetString());
        Assert.Equal(id, line.GetProperty("id").GetString());
        var sent = JsonDocument.Parse(_harness.Stub.Last("add_vocabulary_words")!.Body).RootElement;
        Assert.Equal(StubBackend.UserBookId, sent.GetProperty("userBookId").GetString());
        Assert.False(sent.TryGetProperty("nativeLanguage", out _));

        var updated = await CallAsync(client, "update_vocabulary_word", Args(("id", id), ("translation", "сутінки")));
        AssertOk(updated);
        Assert.Equal("PATCH", _harness.Stub.Last("update_vocabulary_word")!.Method);

        var deleted = await CallAsync(client, "delete_vocabulary_word", Args(("id", id)));
        AssertOk(deleted);
        Assert.True(Json(deleted).GetProperty("deleted").GetBoolean());
    }
}
