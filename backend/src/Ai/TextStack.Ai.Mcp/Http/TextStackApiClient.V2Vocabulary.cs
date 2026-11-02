using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.Ai.Mcp.Http;

/// <summary>
/// The vocabulary tools on the V2 sync API (<see cref="McpBridgeOptions.V2Vocabulary"/>), answered in
/// the legacy shapes the tool catalog already maps, so the tools read the same either way.
/// </summary>
public sealed partial class TextStackApiClient
{
    private const int V2FeedPage = 500;
    private const int LegacyDefaultLimit = 50;
    private const int LegacyMaxLimit = 100;

    /// <summary>
    /// "List my vocabulary" as legacy answers it (live cards, newest first, filtered by stage and by
    /// a search in the word or its translation, paged by offset), over <c>GET /me/v2/vocabulary/changes</c>:
    /// the one V2 read holding every card. <c>/due</c> would leave out every card not due yet.
    /// </summary>
    private async Task<VocabularyPageJson> GetV2VocabularyAsync(int? stage, string? search, int? limit, int? offset, CancellationToken ct)
    {
        // ponytail: pulls the whole feed (500 cards a request) on every call; a server-side list when a
        // vocabulary outgrows a few thousand words.
        var cards = new List<V2WordJson>();
        string? cursor = null;
        do
        {
            var url = $"/me/v2/vocabulary/changes?limit={V2FeedPage}" + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            using var request = await AuthorizedRequestAsync(HttpMethod.Get, url, ct);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode is HttpStatusCode.Unauthorized) throw new McpUnauthorizedException();
            if (response.StatusCode is not HttpStatusCode.OK) return EmptyVocab;
            var page = await response.Content.ReadFromJsonAsync<V2FeedJson>(JsonOptions, ct);
            if (page is null) return EmptyVocab;
            cards.AddRange(page.Items);
            cursor = page.HasMore ? page.Cursor : null;
        } while (cursor is not null);

        var term = search?.Trim().ToLowerInvariant();
        var listed = cards
            .Where(c => c.DeletedAt is null && (stage is null || c.Stage == stage)
                && (string.IsNullOrEmpty(term) || c.Word.ToLowerInvariant().Contains(term) || c.Translation?.Contains(term) == true))
            .OrderByDescending(c => c.CreatedAt)
            .ToList();
        var items = listed.Skip(offset ?? 0).Take(Math.Min(limit ?? LegacyDefaultLimit, LegacyMaxLimit))
            .Select(c => new VocabWordJson(c.Id, c.Word, c.Language, c.Translation, c.Definition, c.Stage,
                c.Examples.FirstOrDefault(e => e.BookTitle is not null)?.BookTitle, c.NextReviewAt))
            .ToList();
        return new VocabularyPageJson(listed.Count, items);
    }

    /// <summary>
    /// <c>PUT /me/v2/vocabulary/words</c>, the sentence as its example. <paramref name="operationId"/> is
    /// both the card's client id and the example's operation id, so a retried call replays instead of
    /// saving twice; a card already under the key keeps its own id. Answered as legacy's
    /// <c>{outcome, word}</c>: <c>srs</c> for a card this save created (now or on the attempt being
    /// retried), <c>already_saved</c> for one that was there before.
    /// </summary>
    private async Task<ApiResult<JsonElement>> SaveV2WordAsync(SaveWordJson word, Guid operationId, CancellationToken ct)
    {
        var example = string.IsNullOrWhiteSpace(word.Sentence)
            ? null
            : new V2ExampleJson(operationId, word.Sentence, word.UserBookId, word.BookTitle);
        using var request = await AuthorizedRequestAsync(HttpMethod.Put, "/me/v2/vocabulary/words", ct);
        request.Content = JsonContent.Create(
            new V2SaveWordJson(operationId, word.Language, word.Word, word.Translation, word.Definition, example), options: JsonOptions);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var result = await ReadResultAsync(response, ct);
        if (result.Error is not null) return result;

        var card = result.Value;
        var created = result.Status is HttpStatusCode.Created || card.GetProperty("id").GetGuid() == operationId;
        return result with { Value = JsonSerializer.SerializeToElement(new { outcome = created ? "srs" : "already_saved", word = card }) };
    }

    /// <summary>
    /// <c>PATCH /me/v2/vocabulary/words/{id}</c> with the revision just read: the bridge holds no copy
    /// of the card. A null field is sent absent, which the merge-patch keeps (legacy's meaning).
    /// </summary>
    private async Task<ApiResult<JsonElement>> UpdateV2WordAsync(Guid id, string? translation, string? definition, CancellationToken ct)
    {
        var path = $"/me/v2/vocabulary/words/{id}";
        using var read = await AuthorizedRequestAsync(HttpMethod.Get, path, ct);
        using var readResponse = await _http.SendAsync(read, HttpCompletionOption.ResponseHeadersRead, ct);
        var card = await ReadResultAsync(readResponse, ct);
        if (card.Error is not null) return card;

        using var request = await AuthorizedRequestAsync(HttpMethod.Patch, path, ct);
        request.Content = JsonContent.Create(
            new V2PatchWordJson(card.Value.GetProperty("revision").GetInt64(), translation, definition), options: JsonOptions);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        return await ReadResultAsync(response, ct);
    }
}

// The /me/v2 vocabulary wire shapes the bridge reads and writes (Contracts.V2's, the subset it needs).
internal sealed record V2FeedJson(IReadOnlyList<V2WordJson> Items, string? Cursor, bool HasMore);

internal sealed record V2WordJson(
    Guid Id, string Word, string Language, string? Translation, string? Definition, int Stage,
    DateTimeOffset NextReviewAt, DateTimeOffset CreatedAt, DateTimeOffset? DeletedAt, IReadOnlyList<V2ExampleJson> Examples);

internal sealed record V2ExampleJson(Guid OperationId, string Sentence, Guid? BookId, string? BookTitle);

internal sealed record V2SaveWordJson(Guid Id, string Language, string Word, string? Translation, string? Definition, V2ExampleJson? Example);

internal sealed record V2PatchWordJson(long ExpectedRevision, string? Translation, string? Definition);
