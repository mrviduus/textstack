using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// add_vocabulary_words / update_vocabulary_word / delete_vocabulary_word against a fake HTTP layer:
/// per-word outcomes, a refused word not blocking the rest, a 429 stopping the batch, and every
/// argument refusal happening before any HTTP call.
/// </summary>
public class McpVocabularyWriteToolsTests
{
    private const string WordId = "11111111-1111-1111-1111-111111111111";

    private sealed class SequenceHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private int _next;
        public List<(HttpMethod Method, string Path, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Requests.Add((request.Method, request.RequestUri!.PathAndQuery, body));
            return responses[Math.Min(_next++, responses.Length - 1)];
        }
    }

    private static (McpToolCatalog, SequenceHandler) Build(params HttpResponseMessage[] responses)
    {
        var handler = new SequenceHandler(responses);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = "textstack.test", McpToken = "tok" };
        return (new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options))), handler);
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static HttpResponseMessage Srs(string word, string id = WordId) =>
        Json($$"""{ "outcome": "srs", "word": { "id": "{{id}}", "word": "{{word}}", "translation": "t" } }""");

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult r) => ((TextContentBlock)r.Content[0]).Text;

    private static JsonElement Results(CallToolResult r) =>
        JsonDocument.Parse(TextOf(r)).RootElement.GetProperty("results");

    private static string Words(int n) =>
        "[" + string.Join(",", Enumerable.Range(0, n).Select(i => $$"""{ "word": "w{{i}}", "language": "en", "translation": "t{{i}}" }""")) + "]";

    [Fact]
    public async Task AddVocabularyWords_MixedOutcomes_ReportsEachWord()
    {
        var (catalog, handler) = Build(
            Srs("alpha"),
            Json($$"""{ "outcome": "already_saved", "word": { "id": "{{WordId}}", "word": "beta", "translation": "бета" } }"""),
            Json("""{ "outcome": "pending", "pendingId": "22222222-2222-2222-2222-222222222222", "reason": "daily_cap" }"""),
            Json("""{ "outcome": "lookup", "lookupId": "33333333-3333-3333-3333-333333333333", "reason": "rare_word" }"""));

        var result = await catalog.CallAsync("add_vocabulary_words", Args($$"""{ "words": {{Words(4)}}, "bookId": "{{WordId}}", "bookTitle": "B" }"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var lines = Results(result);
        Assert.Equal(4, lines.GetArrayLength());
        Assert.Equal("srs", lines[0].GetProperty("status").GetString());
        Assert.Equal(WordId, lines[0].GetProperty("id").GetString());
        Assert.Equal("added; first review today", lines[0].GetProperty("message").GetString());
        Assert.Equal("already_saved", lines[1].GetProperty("status").GetString());
        Assert.Contains("current translation бета", lines[1].GetProperty("message").GetString());
        Assert.Contains("update_vocabulary_word", lines[1].GetProperty("message").GetString());
        Assert.Contains("activates tomorrow", lines[2].GetProperty("message").GetString());
        Assert.False(lines[2].TryGetProperty("id", out _)); // a pending row can't be edited, so no id
        Assert.Contains("reference only", lines[3].GetProperty("message").GetString());

        var sent = JsonDocument.Parse(handler.Requests[0].Body!).RootElement;
        Assert.Equal(WordId, sent.GetProperty("userBookId").GetString());
        Assert.Equal("B", sent.GetProperty("bookTitle").GetString());
        Assert.False(sent.TryGetProperty("nativeLanguage", out _));
    }

    [Fact]
    public async Task AddVocabularyWords_OneWordRefused_OthersStillSaved()
    {
        var (catalog, handler) = Build(
            Srs("w0"),
            Json("\"Word is required (max 200 chars)\"", HttpStatusCode.BadRequest),
            Srs("w2"));

        var result = await catalog.CallAsync("add_vocabulary_words", Args($$"""{ "words": {{Words(3)}} }"""), CancellationToken.None);

        var lines = Results(result);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal("refused", lines[1].GetProperty("status").GetString());
        Assert.Equal("Word is required (max 200 chars)", lines[1].GetProperty("message").GetString());
        Assert.Equal("srs", lines[2].GetProperty("status").GetString());
    }

    [Fact]
    public async Task AddVocabularyWords_NativeLanguageMissing_TellsModelToAskUser()
    {
        var (catalog, _) = Build(Json("""{ "error": "native_language_required" }""", HttpStatusCode.BadRequest));

        var result = await catalog.CallAsync("add_vocabulary_words", Args($$"""{ "words": {{Words(1)}} }"""), CancellationToken.None);

        Assert.Contains("native language in TextStack settings", Results(result)[0].GetProperty("message").GetString());
    }

    [Fact]
    public async Task AddVocabularyWords_429_StopsBatch()
    {
        var (catalog, handler) = Build(
            Srs("w0"),
            Json("""{ "detail": "Vocabulary limit reached (5000 words)" }""", HttpStatusCode.TooManyRequests),
            Srs("w2"));

        var result = await catalog.CallAsync("add_vocabulary_words", Args($$"""{ "words": {{Words(4)}} }"""), CancellationToken.None);

        Assert.Equal(2, handler.Requests.Count);
        var lines = Results(result);
        Assert.Equal(4, lines.GetArrayLength());
        Assert.Equal("stopped", lines[1].GetProperty("status").GetString());
        Assert.Contains("tell the user", lines[1].GetProperty("message").GetString());
        Assert.Equal("not_attempted", lines[2].GetProperty("status").GetString());
        Assert.Equal("not_attempted", lines[3].GetProperty("status").GetString());
    }

    [Theory]
    [InlineData("""{ "words": [] }""")]
    [InlineData("""{ "words": [{ "word": "a", "language": "en" }] }""")] // no translation
    [InlineData("""{ "words": [{ "word": "a", "language": "en", "translation": "" }] }""")]
    [InlineData("""{ "words": [{ "word": "a", "language": "e", "translation": "t" }] }""")] // language too short
    [InlineData("""{ "words": [{ "word": "a", "language": "en", "translation": "t", "extra": 1 }] }""")]
    [InlineData("""{ "words": [{ "word": "a", "language": "en", "translation": "t" }], "bookId": "11111111-1111-1111-1111-111111111111", "editionId": "11111111-1111-1111-1111-111111111111" }""")]
    [InlineData("""{ "words": "a" }""")]
    [InlineData("""{ }""")]
    public async Task AddVocabularyWords_InvalidArgs_ReturnsToolError_NeverHitsHttp(string args)
    {
        var (catalog, handler) = Build(Srs("x"));

        var result = await catalog.CallAsync("add_vocabulary_words", Args(args), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task AddVocabularyWords_MoreThan20_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = Build(Srs("x"));

        var result = await catalog.CallAsync("add_vocabulary_words", Args($$"""{ "words": {{Words(21)}} }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("between 1 and 20", TextOf(result));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ListMyVocabulary_Output_CarriesId()
    {
        var (catalog, _) = Build(Json($$"""
            { "total": 1, "items": [{ "id": "{{WordId}}", "word": "w", "language": "en", "stage": 0, "nextReviewAt": "2026-01-01T00:00:00+00:00" }] }
            """));

        var result = await catalog.CallAsync("list_my_vocabulary", Args("{}"), CancellationToken.None);

        var item = JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("items")[0];
        Assert.Equal(WordId, item.GetProperty("id").GetString());
    }

    [Fact]
    public async Task UpdateVocabularyWord_NoFields_ReturnsToolError_NeverHitsHttp()
    {
        var (catalog, handler) = Build(Json("{}"));

        var result = await catalog.CallAsync("update_vocabulary_word", Args($$"""{ "id": "{{WordId}}" }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("at least one", TextOf(result));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task UpdateVocabularyWord_Valid_PatchesAndMaps()
    {
        var (catalog, handler) = Build(Json($$"""{ "id": "{{WordId}}", "word": "w", "translation": "нове", "definition": null }"""));

        var result = await catalog.CallAsync("update_vocabulary_word", Args($$"""{ "id": "{{WordId}}", "translation": "нове" }"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Patch, handler.Requests[0].Method);
        Assert.Equal($"/me/vocabulary/words/{WordId}", handler.Requests[0].Path);
        Assert.Contains("нове", TextOf(result));
        Assert.False(JsonDocument.Parse(handler.Requests[0].Body!).RootElement.TryGetProperty("definition", out _));
    }

    [Fact]
    public async Task UpdateVocabularyWord_404_SaysWhereIdsComeFrom()
    {
        var (catalog, _) = Build(new HttpResponseMessage(HttpStatusCode.NotFound));

        var result = await catalog.CallAsync("update_vocabulary_word", Args($$"""{ "id": "{{WordId}}", "definition": "d" }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("list_my_vocabulary", TextOf(result));
    }

    [Fact]
    public async Task DeleteVocabularyWord_204_ReadsAsSuccess()
    {
        var (catalog, handler) = Build(new HttpResponseMessage(HttpStatusCode.NoContent));

        var result = await catalog.CallAsync("delete_vocabulary_word", Args($$"""{ "id": "{{WordId}}" }"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(HttpMethod.Delete, handler.Requests[0].Method);
        Assert.True(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("deleted").GetBoolean());
    }

    [Fact]
    public async Task DeleteVocabularyWord_404_SaysWhereIdsComeFrom()
    {
        var (catalog, _) = Build(new HttpResponseMessage(HttpStatusCode.NotFound));

        var result = await catalog.CallAsync("delete_vocabulary_word", Args($$"""{ "id": "{{WordId}}" }"""), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("list_my_vocabulary", TextOf(result));
    }
}
