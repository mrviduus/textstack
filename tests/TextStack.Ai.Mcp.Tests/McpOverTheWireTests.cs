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
/// only the bridge under test → zero ITool in this assembly (StudyBuddy set-equality
/// safe by construction). The AI-047..050 unit tests use fake HttpMessageHandlers and
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

    private async Task<CallToolResult> CallAsync(McpClient client, string tool, Dictionary<string, object?> args) =>
        await client.CallToolAsync(tool, args!, cancellationToken: Ct);

    // ── 1. search_books (public, no Bearer) ───────────────────────────────────────

    [Fact]
    public async Task SearchBooks_OverWire_ReturnsDraculaHit_AndStubSawPublicGet()
    {
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

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
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

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
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

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

    // ── 7. ask_book (Bearer) + spoiler-gate variant ──────────────────────────────

    [Fact]
    public async Task AskBook_OverWire_ForwardsBearer_MapsAnswerAndCitations()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "ask_book", Args(
            ("editionId", StubBackend.GoodEdition),
            ("question", "where does Jonathan Harker travel?"),
            ("k", 5)));

        Assert.NotEqual(true, result.IsError);
        var root = Json(result);
        Assert.Contains("Transylvania", root.GetProperty("answer").GetString());
        var cite = Assert.Single(root.GetProperty("citations").EnumerateArray());
        Assert.Equal(1, cite.GetProperty("marker").GetInt32());

        var req = _harness.Stub.Last("ask_book");
        Assert.Equal("POST", req!.Method);
        Assert.Equal($"/books/{StubBackend.GoodEdition}/ask", req.PathAndQuery);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", req.Authorization);
        var sent = JsonDocument.Parse(req.Body).RootElement;
        Assert.Equal("where does Jonathan Harker travel?", sent.GetProperty("question").GetString());
        Assert.Equal(5, sent.GetProperty("k").GetInt32());
    }

    [Fact]
    public async Task AskBook_SpoilerGate_OverWire_ReturnsCleanText_NotError()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await CallAsync(client, "ask_book", Args(
            ("editionId", StubBackend.SpoilerEdition),
            ("question", "how does the book end?")));

        // Insufficient is expected, not an error — clean relayable text.
        Assert.NotEqual(true, result.IsError);
        Assert.Contains("haven't read far enough", TextOf(result));
    }

    // ── 8. protocol: initialize → serverInfo ──────────────────────────────────────

    [Fact]
    public async Task Initialize_OverWire_ServerInfoNameIsTextstack()
    {
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

        Assert.Equal("textstack", client.ServerInfo.Name);
    }

    // ── 9. protocol: tools/list → exactly the advertised surface ─────────────────

    [Fact]
    public async Task ListTools_OverWire_ReturnsExactlyTheExpectedTools()
    {
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

        var tools = await client.ListToolsAsync(cancellationToken: Ct);

        var names = tools.Select(t => t.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        Assert.Equal(
            ["ask_book", "get_book", "get_chapter", "get_my_book", "get_my_chapter", "get_my_insights", "list_my_book_highlights", "list_my_highlights", "list_my_vocabulary", "save_highlight", "save_insight", "save_my_highlight", "search_books", "search_my_library"],
            names);
    }

    // ── 10. negative: user-scoped WITHOUT bearer → IsError, zero upstream hits ─────

    [Fact]
    public async Task UserScopedTool_NoBearer_OverWire_AuthRequired_StubGotZeroHits()
    {
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

        var result = await CallAsync(client, "list_my_highlights", Args(("editionId", StubBackend.GoodEdition)));

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        // The bridge never issued the upstream call (no token → fail-clean up front).
        Assert.Equal(0, _harness.Stub.TotalRequests);
    }

    // ── 11. negative: invalid args (missing required) → IsError, no upstream call ──

    [Fact]
    public async Task SearchBooks_MissingQuery_OverWire_ToolError_NoUpstreamCall()
    {
        await using var client = await _harness.ConnectAsync(bearer: null, Ct);

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
        await using var client = await broken.ConnectAsync(bearer: null, Ct);

        var result = await client.CallToolAsync(
            "get_book", new Dictionary<string, object?> { ["slug"] = "dracula" }!, cancellationToken: Ct);

        Assert.True(result.IsError);
        Assert.Contains("get_book failed", TextOf(result));
        // Must NOT leak internals to the model.
        Assert.DoesNotContain("Exception", TextOf(result));
    }

    // ── 13. one-session e2e: ONE initialize → list → get_chapter → save → ask ─────

    [Fact]
    public async Task OneSession_OverWire_ListSaveAsk_AllSucceed()
    {
        // A single client (one initialize handshake) exercises the DoD path:
        // "list chapters, save highlight, ask, one session".
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var tools = await client.ListToolsAsync(cancellationToken: Ct);
        Assert.Equal(14, tools.Count);

        var chapter = await CallAsync(client, "get_chapter", Args(("slug", "dracula"), ("chapterSlug", "ch-1")));
        Assert.NotEqual(true, chapter.IsError);

        var saved = await CallAsync(client, "save_highlight", Args(
            ("editionId", StubBackend.GoodEdition),
            ("chapterId", StubBackend.ChapterId),
            ("selectedText", "the dead travel fast")));
        Assert.NotEqual(true, saved.IsError);
        Assert.True(Json(saved).GetProperty("saved").GetBoolean());

        var answer = await CallAsync(client, "ask_book", Args(
            ("editionId", StubBackend.GoodEdition),
            ("question", "what is Jonathan Harker doing?")));
        Assert.NotEqual(true, answer.IsError);
        Assert.Contains("Transylvania", Json(answer).GetProperty("answer").GetString());

        // All three user-scoped calls forwarded the same session bearer.
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("save_highlight")!.Authorization);
        Assert.Equal($"Bearer {McpServerHarness.TestJwt}", _harness.Stub.Last("ask_book")!.Authorization);
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
}
