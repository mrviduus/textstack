using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-047 — the MCP↔HTTP bridge at the level testable without network or a
/// stdio subprocess: the runtime catalog's tools/list shape + schema, and the
/// search_books handler's request → mapping behaviour against a fake HTTP layer.
///
/// Deliberately does NOT spawn the server process or touch stdin/stdout (CI-safe)
/// and introduces NO ITool (the tool-set assertions in StarterToolsTests stay green — the MCP catalog
/// is its own tool model, not an Application ITool).
/// </summary>
public class McpServerTests
{
    private const string SiteHost = "textstack.test";

    /// <summary>Captures the outgoing request and returns a canned response.</summary>
    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            return Task.FromResult(response);
        }
    }

    private static (McpToolCatalog catalog, CapturingHandler handler) BuildCatalog(HttpResponseMessage response)
    {
        var handler = new CapturingHandler(response);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost, McpToken = "t" };
        var api = new TextStackApiClient(http, options, new StaticEnvTokenProvider(options));
        return (new McpToolCatalog(api), handler);
    }

    /// <summary>An HTTP handler whose SendAsync throws — models transport/timeout faults.</summary>
    private sealed class ThrowingHandler(Func<CancellationToken, Exception> factory) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw factory(cancellationToken);
    }

    private static McpToolCatalog BuildCatalogThatThrows(Func<CancellationToken, Exception> factory)
    {
        var http = new HttpClient(new ThrowingHandler(factory)) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost, McpToken = "t" };
        return new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options)));
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult result) =>
        ((TextContentBlock)result.Content[0]).Text;

    // ── tools/list + schema ─────────────────────────────────────────────────────

    [Fact]
    public void ListTools_ExposesSearchBooks_WithExactArgsSchema()
    {
        var (catalog, _) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var tools = catalog.ListTools();

        var tool = Assert.Single(tools, t => t.Name == "search_books");
        // Names the half of the library it searches, and points at the other tool.
        // Two search tools that both say "the TextStack library" is how a model
        // ends up searching the catalog for a book the user uploaded.
        Assert.StartsWith("Search the PUBLIC TextStack catalog", tool.Description);
        Assert.Contains("search_my_library", tool.Description);

        var schema = tool.InputSchema;
        Assert.Equal("object", schema.GetProperty("type").GetString());
        Assert.False(schema.GetProperty("additionalProperties").GetBoolean());

        var required = schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).ToArray();
        Assert.Equal(["query"], required);

        var props = schema.GetProperty("properties");
        var query = props.GetProperty("query");
        Assert.Equal("string", query.GetProperty("type").GetString());
        Assert.Equal(2, query.GetProperty("minLength").GetInt32());
        Assert.Equal(200, query.GetProperty("maxLength").GetInt32());

        var limit = props.GetProperty("limit");
        Assert.Equal("integer", limit.GetProperty("type").GetString());
        Assert.Equal(1, limit.GetProperty("minimum").GetInt32());
        Assert.Equal(50, limit.GetProperty("maximum").GetInt32());
    }

    // ── search_books happy path: request + mapping ──────────────────────────────

    [Fact]
    public async Task CallSearchBooks_MapsHits_AndIssuesGetSearchWithHostHeader()
    {
        const string apiResponse =
            """
            {
              "total": 1,
              "items": [
                {
                  "chapterId": "11111111-1111-1111-1111-111111111111",
                  "chapterSlug": "ch-1",
                  "chapterTitle": "Of Cabbages",
                  "chapterNumber": 1,
                  "edition": {
                    "id": "22222222-2222-2222-2222-222222222222",
                    "slug": "alice",
                    "title": "Alice in Wonderland",
                    "language": "en",
                    "authors": "Lewis Carroll",
                    "coverPath": null
                  },
                  "highlights": ["the <b>walrus</b> said"]
                }
              ]
            }
            """;
        var (catalog, handler) = BuildCatalog(Json(apiResponse));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"walrus","limit":5}"""), CancellationToken.None);

        // (a) issued GET /search?q=walrus&limit=5 with the Host header set.
        Assert.NotNull(handler.LastRequest);
        Assert.Equal(HttpMethod.Get, handler.LastRequest!.Method);
        Assert.Equal("/search?q=walrus&limit=5", handler.LastRequest.RequestUri!.PathAndQuery);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);

        // (b) mapped to the compact MCP text-content shape.
        Assert.NotEqual(true, result.IsError);
        var payload = JsonDocument.Parse(TextOf(result)).RootElement;
        var first = Assert.Single(payload.GetProperty("results").EnumerateArray());
        Assert.Equal("Alice in Wonderland", first.GetProperty("title").GetString());
        Assert.Equal("Lewis Carroll", first.GetProperty("author").GetString());
        Assert.Equal("Of Cabbages", first.GetProperty("chapterTitle").GetString());
        Assert.Equal("alice", first.GetProperty("editionSlug").GetString());
        Assert.Equal("the <b>walrus</b> said", first.GetProperty("snippet").GetString());
    }

    [Fact]
    public async Task CallSearchBooks_OmitsLimit_WhenNotProvided()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"hi"}"""), CancellationToken.None);

        Assert.Equal("/search?q=hi", handler.LastRequest!.RequestUri!.PathAndQuery);
        var payload = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Empty(payload.GetProperty("results").EnumerateArray());
    }

    [Fact]
    public async Task CallSearchBooks_ApiBadRequest_ReturnsEmptyResults()
    {
        var (catalog, _) = BuildCatalog(Json("""{"error":"too short"}""", HttpStatusCode.BadRequest));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var payload = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.Empty(payload.GetProperty("results").EnumerateArray());
    }

    // ── arg validation (mirrors the input schema) ───────────────────────────────

    [Theory]
    [InlineData("""{}""")]                          // missing query
    [InlineData("""{"query":123}""")]               // wrong type
    [InlineData("""{"query":"a"}""")]               // too short (minLength 2)
    [InlineData("""{"query":"ok","limit":99}""")]   // limit out of range
    [InlineData("""{"query":"ok","limit":"5"}""")]  // limit wrong type
    [InlineData("""{"query":"ok","extra":true}""")] // additionalProperties:false
    public async Task CallSearchBooks_InvalidArgs_ReturnsToolError(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest); // never reached the HTTP layer
    }

    [Fact]
    public async Task CallSearchBooks_ValidArgs_ReturnsContent_NotError()
    {
        var (catalog, _) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"valid"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.NotEmpty(result.Content);
    }

    [Fact]
    public async Task Call_UnknownTool_ReturnsToolError()
    {
        var (catalog, _) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("does_not_exist", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
    }

    // ── arg validation: additional edge cases (AI-047 review hardening) ──────────

    [Theory]
    [InlineData("""{"query":null}""")]              // JSON null literal (not missing)
    [InlineData("""{"query":["a","b"]}""")]         // array, not string
    [InlineData("""{"query":{"x":1}}""")]           // object, not string
    [InlineData("""{"query":true}""")]              // bool, not string
    [InlineData("""{"query":"ok","limit":0}""")]    // limit below minimum
    [InlineData("""{"query":"ok","limit":-5}""")]   // negative limit
    [InlineData("""{"query":"ok","limit":5.5}""")]  // non-integer number
    [InlineData("""{"query":"ok","limit":99999999999}""")] // overflows Int32
    [InlineData("""{"query":"ok","limit":null}""")] // limit null literal
    public async Task CallSearchBooks_MoreInvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest); // validation gate must short-circuit before HTTP
    }

    [Fact]
    public async Task CallSearchBooks_QueryAt200Chars_IsValid_AndCallsHttp()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));
        var q = new string('a', 200);

        var result = await catalog.CallAsync("search_books", Args($$"""{"query":"{{q}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.NotNull(handler.LastRequest);
        Assert.Equal($"/search?q={q}", handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task CallSearchBooks_QueryAt201Chars_ReturnsToolError()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));
        var q = new string('a', 201);

        var result = await catalog.CallAsync("search_books", Args($$"""{"query":"{{q}}"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task CallSearchBooks_LimitAt50_IsValid()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok","limit":50}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal("/search?q=ok&limit=50", handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    // ── querystring safety: special chars must be escaped, not injected ──────────

    [Fact]
    public async Task CallSearchBooks_QueryWithSpecialChars_IsUrlEscaped()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        // '&' and '=' would forge extra querystring params if not escaped.
        var result = await catalog.CallAsync(
            "search_books", Args("""{"query":"a&limit=999 b","limit":3}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var query = handler.LastRequest!.RequestUri!.Query;
        // The raw '&'/'='/space from the query must be percent-encoded, leaving
        // exactly one real 'limit' param (=3), not the injected 999.
        Assert.Contains("q=a%26limit%3D999", query);
        Assert.Contains("&limit=3", query);
        Assert.DoesNotContain("limit=999", query);
    }

    [Fact]
    public async Task CallSearchBooks_UnicodeQuery_IsUrlEscaped()
    {
        var (catalog, handler) = BuildCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"café"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal("/search?q=caf%C3%A9", handler.LastRequest!.RequestUri!.PathAndQuery);
    }

    // ── mapping: null/absent fields in the API response must not NPE ─────────────

    [Fact]
    public async Task CallSearchBooks_NullAuthorChapterAndNoHighlights_MapToEmptyStrings()
    {
        const string apiResponse =
            """
            {
              "total": 1,
              "items": [
                {
                  "chapterId": "11111111-1111-1111-1111-111111111111",
                  "chapterSlug": "ch-1",
                  "chapterTitle": null,
                  "chapterNumber": 1,
                  "edition": {
                    "id": "22222222-2222-2222-2222-222222222222",
                    "slug": "alice",
                    "title": "Alice",
                    "language": "en",
                    "authors": null,
                    "coverPath": null
                  },
                  "highlights": null
                }
              ]
            }
            """;
        var (catalog, _) = BuildCatalog(Json(apiResponse));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"alice"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var first = Assert.Single(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("results").EnumerateArray());
        Assert.Equal("", first.GetProperty("author").GetString());
        Assert.Equal("", first.GetProperty("chapterTitle").GetString());
        Assert.Equal("", first.GetProperty("snippet").GetString());
        Assert.Equal("alice", first.GetProperty("editionSlug").GetString());
    }

    [Fact]
    public async Task CallSearchBooks_EmptyHighlightsArray_SnippetIsEmpty()
    {
        const string apiResponse =
            """
            {
              "total": 1,
              "items": [
                {
                  "chapterId": "11111111-1111-1111-1111-111111111111",
                  "chapterSlug": "ch-1",
                  "chapterTitle": "T",
                  "chapterNumber": 1,
                  "edition": {
                    "id": "22222222-2222-2222-2222-222222222222",
                    "slug": "s",
                    "title": "T",
                    "language": "en",
                    "authors": "A",
                    "coverPath": null
                  },
                  "highlights": []
                }
              ]
            }
            """;
        var (catalog, _) = BuildCatalog(Json(apiResponse));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"tt"}"""), CancellationToken.None);

        var first = Assert.Single(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("results").EnumerateArray());
        Assert.Equal("", first.GetProperty("snippet").GetString());
    }

    // ── HTTP bridge robustness: non-OK + malformed-body behaviour ────────────────

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]            // unknown site
    [InlineData(HttpStatusCode.InternalServerError)] // upstream 5xx
    [InlineData(HttpStatusCode.ServiceUnavailable)]  // upstream down
    [InlineData((HttpStatusCode)429)]                // rate limited
    public async Task CallSearchBooks_NonOkStatus_ReturnsEmptyResults_NotError(HttpStatusCode status)
    {
        var (catalog, _) = BuildCatalog(Json("""{"error":"x"}""", status));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Empty(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("results").EnumerateArray());
    }

    [Fact]
    public async Task CallSearchBooks_Ok200WithMalformedBody_ReturnsToolError()
    {
        // P2 fix: a 200 with a non-JSON body (e.g. an HTML error page that slips a
        // 200, or a truncated stream) makes ReadFromJsonAsync throw JsonException.
        // The catalog handler now catches it and returns a clean IsError tool
        // result — NOT a JSON-RPC protocol fault — so an interactive client sees a
        // usable message and the session continues.
        var (catalog, _) = BuildCatalog(Json("<html>oops</html>"));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("search_books failed", TextOf(result));
    }

    [Fact]
    public async Task CallSearchBooks_ConnectionFailure_ReturnsToolError()
    {
        // DNS / connection refused → HttpRequestException → clean IsError, no throw.
        var catalog = BuildCatalogThatThrows(_ => new HttpRequestException("connection refused"));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("search_books failed", TextOf(result));
    }

    [Fact]
    public async Task CallSearchBooks_HttpClientTimeout_ReturnsToolError()
    {
        // The HttpClient's own timeout surfaces as TaskCanceledException but the
        // CALLER token is NOT cancelled — that's a timeout, not cooperative
        // cancellation → clean IsError (not a protocol fault, not swallowed-silent).
        var catalog = BuildCatalogThatThrows(_ => new TaskCanceledException("timeout"));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("search_books failed", TextOf(result));
    }

    [Fact]
    public async Task CallSearchBooks_RealClientCancellation_Propagates()
    {
        // Genuine cooperative cancellation (client disconnected): the caller's token
        // IS cancelled. This must propagate (the SDK ends the call) — NOT be
        // converted to an IsError tool result.
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var catalog = BuildCatalogThatThrows(ct => new OperationCanceledException(ct));

        // Propagates as OperationCanceledException (HttpClient may re-wrap it as the
        // TaskCanceledException subclass) — the point is it is NOT swallowed into IsError.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => catalog.CallAsync("search_books", Args("""{"query":"ok"}"""), cts.Token));
    }
}
