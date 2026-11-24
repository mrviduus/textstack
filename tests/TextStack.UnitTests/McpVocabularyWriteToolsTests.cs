using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// add_vocabulary_words / update_vocabulary_word / delete_vocabulary_word against a fake V2 API:
/// per-word outcomes, a refused word not blocking the rest, a 429 stopping the batch, and every
/// argument refusal happening before any HTTP call.
/// </summary>
public class McpVocabularyWriteToolsTests
{
    private const string WordId = "11111111-1111-1111-1111-111111111111";
    private const string OperationId = "22222222-2222-2222-2222-222222222222";

    /// <summary>Answers each request in turn; a null answer echoes a new card under the id the request sent.</summary>
    private sealed class SequenceHandler(params HttpResponseMessage?[] responses) : HttpMessageHandler
    {
        private int _next;
        public List<(HttpMethod Method, string Path, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Requests.Add((request.Method, request.RequestUri!.PathAndQuery, body));
            return responses[Math.Min(_next++, responses.Length - 1)]
                ?? Json(Card(JsonDocument.Parse(body!).RootElement.GetProperty("id").GetString()!), HttpStatusCode.Created);
        }
    }

    private static (McpToolCatalog, SequenceHandler) Build(params HttpResponseMessage?[] responses)
    {
        var handler = new SequenceHandler(responses);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = "textstack.test", McpToken = "tok" };
        return (new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options))), handler);
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static string Card(string id, string translation = "t", long revision = 1) =>
        $$"""
        {
          "id": "{{id}}", "language": "en", "word": "w", "translation": "{{translation}}", "definition": null,
          "stage": 0, "intervalDays": 0, "consecutiveCorrect": 0, "nextReviewAt": "2026-11-02T10:00:00Z", "lastReviewedAt": null,
          "createdAt": "2026-11-01T09:00:00Z", "updatedAt": "2026-11-01T10:00:00Z", "deletedAt": null, "retiredAt": null,
          "revision": {{revision}}, "examples": []
        }
        """;

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult r) => ((TextContentBlock)r.Content[0]).Text;

    private static JsonElement Results(CallToolResult r) =>
        JsonDocument.Parse(TextOf(r)).RootElement.GetProperty("results");

    private static string Words(int n) =>
        "[" + string.Join(",", Enumerable.Range(0, n).Select(i => $$"""{ "word": "w{{i}}", "language": "en", "translation": "t{{i}}" }""")) + "]";

    [Fact]
    public async Task AddVocabularyWords_NewAndAlreadySaved_ReportsEachWord()
    {
        var (catalog, handler) = Build(null, Json(Card(WordId, "бета")));

        var result = await catalog.CallAsync("add_vocabulary_words",
            Args($$"""
                { "operationId": "{{OperationId}}", "bookTitle": "B", "words": [
                  { "word": "w0", "language": "en", "translation": "t0", "sentence": "A w0 here." },
                  { "word": "w1", "language": "en", "translation": "t1" }] }
                """), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var lines = Results(result);
        Assert.Equal("srs", lines[0].GetProperty("status").GetString());
        Assert.Equal("added; first review today", lines[0].GetProperty("message").GetString());
        Assert.Equal("already_saved", lines[1].GetProperty("status").GetString());
        Assert.Equal(WordId, lines[1].GetProperty("id").GetString());
        Assert.Contains("current translation бета", lines[1].GetProperty("message").GetString());

        var sent = JsonDocument.Parse(handler.Requests[0].Body!).RootElement;
        Assert.Equal(HttpMethod.Put, handler.Requests[0].Method);
        Assert.Equal(("A w0 here.", "B"), (sent.GetProperty("example").GetProperty("sentence").GetString(), sent.GetProperty("example").GetProperty("bookTitle").GetString()));
    }

    [Fact]
    public async Task AddVocabularyWords_OneWordRefused_OthersStillSaved()
    {
        var (catalog, handler) = Build(
            null,
            Json("""{ "error": "validation_failed", "message": "Word is required (max 200 chars)" }""", HttpStatusCode.BadRequest),
            null);

        var result = await catalog.CallAsync("add_vocabulary_words",
            Args($$"""{ "operationId": "{{OperationId}}", "words": {{Words(3)}} }"""), CancellationToken.None);

        var lines = Results(result);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal("refused", lines[1].GetProperty("status").GetString());
        Assert.Equal("Word is required (max 200 chars)", lines[1].GetProperty("message").GetString());
        Assert.Equal("srs", lines[2].GetProperty("status").GetString());
    }

    [Fact]
    public async Task AddVocabularyWords_429_StopsBatch()
    {
        var (catalog, handler) = Build(
            null,
            Json("""{ "detail": "Too many requests" }""", HttpStatusCode.TooManyRequests),
            null);

        var result = await catalog.CallAsync("add_vocabulary_words",
            Args($$"""{ "operationId": "{{OperationId}}", "words": {{Words(4)}} }"""), CancellationToken.None);

        Assert.Equal(2, handler.Requests.Count);
        var lines = Results(result);
        Assert.Equal(4, lines.GetArrayLength());
        Assert.Equal("stopped", lines[1].GetProperty("status").GetString());
        Assert.Contains("tell the user", lines[1].GetProperty("message").GetString());
        Assert.Equal("not_attempted", lines[2].GetProperty("status").GetString());
        Assert.Equal("not_attempted", lines[3].GetProperty("status").GetString());
    }

    [Theory]
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": [] }""")]
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": [{ "word": "a", "language": "en" }] }""")] // neither translation nor definition
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": [{ "word": "a", "language": "en", "translation": "" }] }""")]
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": [{ "word": "a", "language": "e", "translation": "t" }] }""")] // language too short
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": [{ "word": "a", "language": "en", "translation": "t", "extra": 1 }] }""")]
    [InlineData("""{ "operationId": "22222222-2222-2222-2222-222222222222", "words": "a" }""")]
    [InlineData("""{ "words": [{ "word": "a", "language": "en", "translation": "t" }] }""")] // no operationId
    [InlineData("""{ "operationId": "not-a-uuid", "words": [{ "word": "a", "language": "en", "translation": "t" }] }""")]
    [InlineData("""{ }""")]
    public async Task AddVocabularyWords_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = Build(null);

        var result = await catalog.CallAsync("add_vocabulary_words", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task AddVocabularyWords_MoreThan20_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = Build(null);

        var result = await catalog.CallAsync("add_vocabulary_words",
            Args($$"""{ "operationId": "{{OperationId}}", "words": {{Words(21)}} }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("between 1 and 20", TextOf(result));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task UpdateVocabularyWord_NoFields_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = Build(null);

        var result = await catalog.CallAsync("update_vocabulary_word", Args($$"""{ "id": "{{WordId}}" }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("at least one", TextOf(result));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task UpdateVocabularyWord_Valid_PatchesOnTheRevisionJustRead()
    {
        var (catalog, handler) = Build(Json(Card(WordId, revision: 3)), Json(Card(WordId, "нове", revision: 4)));

        var result = await catalog.CallAsync("update_vocabulary_word", Args($$"""{ "id": "{{WordId}}", "translation": "нове" }"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Patch, handler.Requests[1].Method);
        Assert.Equal($"/me/v2/vocabulary/words/{WordId}", handler.Requests[1].Path);
        var sent = JsonDocument.Parse(handler.Requests[1].Body!).RootElement;
        Assert.Equal(3, sent.GetProperty("expectedRevision").GetInt64());
        Assert.False(sent.TryGetProperty("definition", out _));
        Assert.Contains("нове", TextOf(result));
    }

    [Fact]
    public async Task UpdateVocabularyWord_404_SaysWhereIdsComeFrom()
    {
        var (catalog, _) = Build(Json("""{ "error": "not_found", "message": "The server has no such item." }""", HttpStatusCode.NotFound));

        var result = await catalog.CallAsync("update_vocabulary_word", Args("""{ "id": "11111111-1111-1111-1111-111111111111", "definition": "d" }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("list_my_vocabulary", TextOf(result));
    }

    [Fact]
    public async Task DeleteVocabularyWord_Tombstone_ReadsAsSuccess()
    {
        var (catalog, handler) = Build(Json(Card(WordId)));

        var result = await catalog.CallAsync("delete_vocabulary_word", Args($$"""{ "id": "{{WordId}}" }"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Delete, handler.Requests[0].Method);
        Assert.Equal($"/me/v2/vocabulary/words/{WordId}", handler.Requests[0].Path);
        Assert.True(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("deleted").GetBoolean());
    }
}
