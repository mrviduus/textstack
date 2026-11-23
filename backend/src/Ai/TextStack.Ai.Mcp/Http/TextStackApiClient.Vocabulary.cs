using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Contracts.Sync;

namespace TextStack.Ai.Mcp.Http;

/// <summary>
/// The vocabulary tools on the V2 sync API, answered in the shapes the tool catalog maps.
/// </summary>
public sealed partial class TextStackApiClient
{
    private const int FeedPage = 500;
    // list_my_vocabulary's page: 50 by default, at most 100.
    private const int DefaultLimit = 50;
    private const int MaxLimit = 100;

    /// <summary>
    /// "List my vocabulary" (live cards, newest first, filtered by stage and by
    /// a search in the word or its translation, paged by offset), over <c>GET /me/v2/vocabulary/changes</c>:
    /// the one V2 read holding every card. <c>/due</c> would leave out every card not due yet.
    /// </summary>
    public async Task<ApiResult<VocabularyPageJson>> GetVocabularyAsync(int? stage, string? search, int? limit, int? offset, CancellationToken ct)
    {
        // ponytail: pulls the whole feed (500 cards a request) on every call; a server-side list when a
        // vocabulary outgrows a few thousand words.
        // Never "no words" for a page that did not come: a refusal is the tool's error, with the server's message.
        var feed = await PullAllAsync<VocabularyWordDto>("/me/v2/vocabulary/changes", ct);
        if (feed.Error is { } refused) return new(null, refused, feed.Status, feed.Code);
        var cards = feed.Value!;

        var term = search?.Trim();
        var listed = cards
            .Where(c => c.DeletedAt is null && (stage is null || c.Stage == stage)
                && (string.IsNullOrEmpty(term) || c.Word.Contains(term, StringComparison.OrdinalIgnoreCase)
                    || c.Translation?.Contains(term, StringComparison.OrdinalIgnoreCase) == true))
            .OrderByDescending(c => c.CreatedAt)
            .ToList();
        var items = listed.Skip(offset ?? 0).Take(Math.Min(limit ?? DefaultLimit, MaxLimit))
            .Select(c => new VocabWordJson(c.Id, c.Word, c.Language, c.Translation, c.Definition, c.Stage,
                c.Examples.FirstOrDefault(e => e.BookTitle is not null)?.BookTitle, c.NextReviewAt))
            .ToList();
        return new(new VocabularyPageJson(listed.Count, items), null);
    }

    /// <summary>
    /// <c>PUT /me/v2/vocabulary/words</c>, the sentence as its example, under one id per word: both the
    /// card's client id and the example's operation id, so a retried call replays instead of saving
    /// twice; a card already under the key keeps its own id. Answered as <c>{outcome, word}</c>:
    /// <c>srs</c> for a card this save created (now or on the attempt being retried), else <c>already_saved</c>.
    /// </summary>
    public async Task<ApiResult<JsonElement>> SaveWordAsync(SaveWordJson word, Guid operationId, CancellationToken ct)
    {
        var id = WordId(operationId, word);
        // The book the model named; the server checks it is the user's (an unknown id refuses the word).
        // ponytail: no fileId or chapterKey; add them when an assistant needs a word's chapter.
        var example = string.IsNullOrWhiteSpace(word.Sentence)
            ? null
            : new VocabularyExampleRequest(id, word.Sentence, null, word.UserBookId, null, null, word.BookTitle);
        var result = await SendAsync(HttpMethod.Put, "/me/v2/vocabulary/words",
            new SaveVocabularyWordRequest(id, word.Language, word.Word, word.Translation, word.Definition, example), ct);
        if (result.Error is not null) return result;

        var card = result.Value.Deserialize<VocabularyWordDto>(JsonOptions)!;
        var outcome = card.Id == id ? "srs" : "already_saved";
        return result with { Value = JsonSerializer.SerializeToElement(new { outcome, word = new { id = card.Id, translation = card.Translation } }) };
    }

    /// <summary>
    /// Deterministic per (call, language, word key): a retry gets the same id whatever the word order.
    /// The bridge's own trim + lowercase; it need not match the server's key, only be stable.
    /// </summary>
    private static Guid WordId(Guid operationId, SaveWordJson word) =>
        new(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{operationId:D}\n{word.Language.Trim().ToLowerInvariant()}\n{word.Word.Trim().ToLowerInvariant()}")).AsSpan(0, 16));

    /// <summary>
    /// <c>PATCH /me/v2/vocabulary/words/{id}</c> with the revision just read: the bridge holds no copy
    /// of the card. A null field is sent absent, which the merge-patch keeps.
    /// </summary>
    public async Task<ApiResult<JsonElement>> UpdateWordAsync(Guid id, string? translation, string? definition, CancellationToken ct)
    {
        var path = $"/me/v2/vocabulary/words/{id}";
        var card = await SendAsync<object>(HttpMethod.Get, path, null, ct);
        if (card.Error is not null) return card;
        return await SendAsync(HttpMethod.Patch, path,
            new PatchWordJson(card.Value.Deserialize<VocabularyWordDto>(JsonOptions)!.Revision, translation, definition), ct);
    }
}

// PatchVocabularyWordRequest's JsonElement members exist to tell absent from null on the server; the
// bridge only ever omits a field, so a plain record (nulls dropped on the wire) says the same.
internal sealed record PatchWordJson(long ExpectedRevision, string? Translation, string? Definition);
