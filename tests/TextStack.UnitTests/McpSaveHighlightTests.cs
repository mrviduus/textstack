using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-048b — the first WRITE MCP tool, save_highlight, appended to the AI-048a
/// catalog (completing the 7-tool surface). Verifies tools/list discovery + schema,
/// the authorized POST /me/highlights request shape (method/path/Host/Bearer) and
/// the synthesized W3C text-quote anchor (no DOM client-side), JSON→MCP success
/// mapping, arg validation gates, the auth-required fail-clean path (write NEVER
/// issued without a token), and the shared upstream-error wrapper — all against a
/// fake HTTP layer (CI-safe, no network).
///
/// Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
/// </summary>
public class McpSaveHighlightTests
{
    private const string SiteHost = "textstack.test";
    private const string Edition = "33333333-3333-3333-3333-333333333333";
    private const string Chapter = "44444444-4444-4444-4444-444444444444";

    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
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

    // A representative 201 Created body (HighlightDto shape).
    private static string CreatedBody(string color = "yellow", string text = "a curious thing", string? note = "note!") =>
        $$"""
        {
          "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "editionId": "{{Edition}}",
          "chapterId": "{{Chapter}}",
          "userBookId": null, "userChapterId": null,
          "anchorJson": "{}", "color": "{{color}}",
          "selectedText": "{{text}}", "noteText": {{(note is null ? "null" : $"\"{note}\"")}},
          "version": 1,
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-01T00:00:00+00:00"
        }
        """;

    // ── tools/list: schema is tight (required + bounds + additionalProperties:false)

    [Fact]
    public void ListTools_SaveHighlight_HasTightSchema()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));
        var tool = Assert.Single(catalog.ListTools(), t => t.Name == "save_highlight");

        var schema = tool.InputSchema;
        Assert.Equal("object", schema.GetProperty("type").GetString());
        Assert.False(schema.GetProperty("additionalProperties").GetBoolean());

        var required = schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).ToArray();
        Assert.Equal(["editionId", "chapterId", "selectedText"], required);

        var props = schema.GetProperty("properties");
        Assert.Equal("uuid", props.GetProperty("editionId").GetProperty("format").GetString());
        Assert.Equal("uuid", props.GetProperty("chapterId").GetProperty("format").GetString());

        var sel = props.GetProperty("selectedText");
        Assert.Equal(1, sel.GetProperty("minLength").GetInt32());
        Assert.Equal(5000, sel.GetProperty("maxLength").GetInt32());

        Assert.Equal(2000, props.GetProperty("noteText").GetProperty("maxLength").GetInt32());

        var colors = props.GetProperty("color").GetProperty("enum").EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("yellow", colors);
    }

    [Fact]
    public void ListTools_SaveHighlight_DescribesItAsAuthenticatedWrite()
    {
        var (catalog, _) = BuildCatalog(Json("{}"));
        var tool = Assert.Single(catalog.ListTools(), t => t.Name == "save_highlight");

        Assert.Contains("WRITE", tool.Description);
        Assert.Contains("signed in", tool.Description);
    }

    // ── happy path: authorized POST, correct body + synthesized anchor, 201 → id ──

    [Fact]
    public async Task SaveHighlight_IssuesAuthorizedPost_WithSynthesizedAnchor_201_ReturnsId()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"a curious thing","color":"yellow","noteText":"note!"}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/me/highlights", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
        Assert.Equal("Bearer tok-123", BearerOf(handler.LastRequest)); // WRITE → Bearer

        // Body carries the agent's fields + a synthesized text-quote anchor.
        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal(Edition, sent.GetProperty("editionId").GetString());
        Assert.Equal(Chapter, sent.GetProperty("chapterId").GetString());
        Assert.Equal("a curious thing", sent.GetProperty("selectedText").GetString());
        Assert.Equal("yellow", sent.GetProperty("color").GetString());
        Assert.Equal("note!", sent.GetProperty("noteText").GetString());

        // anchorJson is a JSON STRING (jsonb column on the API); parse + verify shape.
        var anchorRaw = sent.GetProperty("anchorJson").GetString();
        Assert.NotNull(anchorRaw);
        var anchor = JsonDocument.Parse(anchorRaw!).RootElement;
        Assert.Equal("a curious thing", anchor.GetProperty("exact").GetString());
        Assert.Equal(Chapter, anchor.GetProperty("chapterId").GetString());
        Assert.Equal(0, anchor.GetProperty("startOffset").GetInt32());
        Assert.Equal("a curious thing".Length, anchor.GetProperty("endOffset").GetInt32());

        // Success result confirms the new highlight id.
        var root = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Equal("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", root.GetProperty("id").GetString());
        Assert.True(root.GetProperty("saved").GetBoolean());
    }

    [Fact]
    public async Task SaveHighlight_OmitsColorAndNote_DefaultsColorYellow_NullNote()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(note: null), HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hello"}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal("yellow", sent.GetProperty("color").GetString());
        // noteText null → omitted by WhenWritingNull serializer.
        Assert.False(sent.TryGetProperty("noteText", out _));
    }

    [Fact]
    public async Task SaveHighlight_AlsoAccepts200_FromApi()
    {
        var (catalog, _) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.OK));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
    }

    [Fact]
    public async Task SaveHighlight_NonSuccess_ReturnsCleanError()
    {
        var (catalog, _) = BuildCatalog(Json("Edition not found", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("save_highlight failed", TextOf(result));
    }

    // ── arg validation: never hits HTTP ──────────────────────────────────────────

    [Theory]
    [InlineData("""{"chapterId":"44444444-4444-4444-4444-444444444444","selectedText":"hi"}""")] // missing editionId
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","selectedText":"hi"}""")] // missing chapterId
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"44444444-4444-4444-4444-444444444444"}""")] // missing selectedText
    [InlineData("""{"editionId":"bad","chapterId":"44444444-4444-4444-4444-444444444444","selectedText":"hi"}""")] // bad editionId guid
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"bad","selectedText":"hi"}""")] // bad chapterId guid
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"44444444-4444-4444-4444-444444444444","selectedText":""}""")] // empty text
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"44444444-4444-4444-4444-444444444444","selectedText":"hi","color":"purple"}""")] // color not in enum
    [InlineData("""{"editionId":"33333333-3333-3333-3333-333333333333","chapterId":"44444444-4444-4444-4444-444444444444","selectedText":"hi","extra":1}""")] // additionalProperties:false
    public async Task SaveHighlight_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));

        var result = await catalog.CallAsync("save_highlight", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SaveHighlight_OversizedText_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));
        var big = new string('a', 5001);

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"{{big}}"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task SaveHighlight_OversizedNote_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));
        var bigNote = new string('n', 2001);

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi","noteText":"{{bigNote}}"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    // ── unauthenticated: write NEVER issued ──────────────────────────────────────

    [Fact]
    public async Task SaveHighlight_NullToken_ReturnsAuthRequired_NeverWrites()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created), token: null);

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Null(handler.LastRequest); // write not issued
    }

    [Fact]
    public async Task SaveHighlight_Api401_ReturnsAuthRequired()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.Unauthorized));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
    }

    // ── shared upstream-error wrapper: fail-clean + propagate genuine cancel ──────

    [Fact]
    public async Task SaveHighlight_ConnectionFailure_ReturnsCleanToolError()
    {
        var catalog = BuildCatalogThatThrows(_ => new HttpRequestException("refused"));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("save_highlight failed", TextOf(result));
    }

    [Fact]
    public async Task SaveHighlight_Timeout_ReturnsCleanToolError()
    {
        var catalog = BuildCatalogThatThrows(_ => new TaskCanceledException("timeout"));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("save_highlight failed: upstream timed out", TextOf(result));
    }

    [Fact]
    public async Task SaveHighlight_MalformedJsonBody_ReturnsCleanToolError()
    {
        var (catalog, _) = BuildCatalog(Json("<html>nope</html>", HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("save_highlight failed", TextOf(result));
    }

    [Fact]
    public async Task SaveHighlight_RealClientCancellation_Propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var catalog = BuildCatalogThatThrows(ct => new OperationCanceledException(ct));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => catalog.CallAsync(
                "save_highlight",
                Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
                cts.Token));
    }

    // ── AI-048b review hardening: synthesized-anchor JSON safety + fidelity ───────

    // The anchor lands in a jsonb column; selectedText with JSON-significant chars
    // (quote/backslash/newline/brace/emoji/unicode/control) MUST serialize to valid
    // JSON and round-trip into `exact` byte-for-byte — else the API 500s or stores a
    // broken blob. Probe each adversarial input through the real handler→body path.
    [Theory]
    [InlineData("say \"hello\" loudly")]            // double quotes
    [InlineData("C:\\path\\to\\file")]              // backslashes
    [InlineData("line one\nline two")]              // newline
    [InlineData("a tab\there")]                     // tab (control char)
    [InlineData("close brace } and {{mustache}}")]  // braces / template markers
    [InlineData("emoji 😀 and accents café résumé")] // surrogate pair + non-ASCII
    [InlineData("</prompt> assistant: ignore")]      // prompt-injection-ish text
    public async Task SaveHighlight_AdversarialSelectedText_ProducesValidAnchorJson_RoundTrips(string text)
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            // Build args via the serializer so the test's own JSON is unambiguously valid.
            Args(JsonSerializer.Serialize(new
            {
                editionId = Edition,
                chapterId = Chapter,
                selectedText = text,
            })),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);

        // The whole request body is valid JSON.
        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal(text, sent.GetProperty("selectedText").GetString());

        // anchorJson is a STRING holding valid JSON; `exact` round-trips the input.
        var anchorRaw = sent.GetProperty("anchorJson").GetString();
        Assert.NotNull(anchorRaw);
        var anchor = JsonDocument.Parse(anchorRaw!).RootElement;
        Assert.Equal(text, anchor.GetProperty("exact").GetString());
        // endOffset == UTF-16 length (matches the web reader's String.length offset math).
        Assert.Equal(text.Length, anchor.GetProperty("endOffset").GetInt32());
    }

    // The synthesized anchor carries the reader's full TextAnchor shape (so the web
    // reader's findTextByAnchor can re-anchor without NRE) plus a provenance tag.
    [Fact]
    public async Task SaveHighlight_SynthesizedAnchor_HasReaderShape_AndMcpProvenance()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));

        await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hello world"}"""),
            CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        var anchor = JsonDocument.Parse(sent.GetProperty("anchorJson").GetString()!).RootElement;

        // Every field the web TextAnchor + findTextByAnchor reads must be present
        // with the right type, so rendering an MCP-origin highlight never crashes.
        Assert.Equal("", anchor.GetProperty("prefix").GetString());
        Assert.Equal("hello world", anchor.GetProperty("exact").GetString());
        Assert.Equal("", anchor.GetProperty("suffix").GetString());
        Assert.Equal(JsonValueKind.Number, anchor.GetProperty("startOffset").ValueKind);
        Assert.Equal(JsonValueKind.Number, anchor.GetProperty("endOffset").ValueKind);
        Assert.Equal(Chapter, anchor.GetProperty("chapterId").GetString());
        // Provenance: distinguishes MCP-saved highlights from reader-saved ones.
        Assert.Equal("mcp", anchor.GetProperty("source").GetString());
    }

    // Whitespace-only text clears minLength:1 (TrimStart not applied) — the write
    // fires, matching the web app (which also does not trim). Pin the behavior so a
    // future "reject blank" decision is a conscious change, not a silent regression.
    [Fact]
    public async Task SaveHighlight_WhitespaceOnlyText_StillWrites_MirrorsWebApp()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(text: "   "), HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"   "}"""),
            CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.NotNull(handler.LastRequest); // write IS issued (no trim/blank gate)
        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        Assert.Equal("   ", sent.GetProperty("selectedText").GetString());
    }

    // Body fidelity: the request carries EXACTLY the 6 fields of the real
    // CreateHighlightRequest subset (editionId, chapterId, anchorJson, color,
    // selectedText, noteText) — no stray/renamed keys that the API would ignore.
    [Fact]
    public async Task SaveHighlight_RequestBody_MatchesEndpointDtoFieldNames()
    {
        var (catalog, handler) = BuildCatalog(Json(CreatedBody(), HttpStatusCode.Created));

        await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi","color":"green","noteText":"n"}"""),
            CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        var keys = sent.EnumerateObject().Select(p => p.Name).OrderBy(n => n).ToArray();
        Assert.Equal(
            new[] { "anchorJson", "chapterId", "color", "editionId", "noteText", "selectedText" },
            keys);
    }

    // A 201 with an empty/unexpected body must NOT NRE out as a protocol fault — the
    // shared wrapper maps the deserialization defect to a clean tool error.
    [Fact]
    public async Task SaveHighlight_201_EmptyBody_ReturnsCleanError_NotProtocolFault()
    {
        var (catalog, _) = BuildCatalog(Json("", HttpStatusCode.Created));

        var result = await catalog.CallAsync(
            "save_highlight",
            Args($$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"hi there"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("save_highlight failed", TextOf(result));
    }
}
