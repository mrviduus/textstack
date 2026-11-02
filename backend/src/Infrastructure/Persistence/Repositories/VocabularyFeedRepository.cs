using Application.Vocabulary;
using Dapper;
using Domain.Vocabulary;
using static Infrastructure.Persistence.Repositories.VocabularyRepository;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IVocabularyFeedRepository"/> on <c>textstack_v2</c>: a page of
/// cards, then the live examples of the whole page in one statement (never one per card).
/// </summary>
public sealed class VocabularyFeedRepository(V2DataSource dataSource) : IVocabularyFeedRepository
{
    // Matches the partial index ix_vocabulary_words_user_id_next_review_at (live, unretired cards by due time).
    private const string SelectDueWords = $"""
        SELECT {WordColumns} FROM vocabulary_words
        WHERE user_id = @userId AND deleted_at IS NULL AND retired_at IS NULL AND next_review_at <= @now
        ORDER BY next_review_at, id
        LIMIT @limit
        """;

    public async Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        return await WithExamplesAsync(SelectDueWords, new { userId, now, limit }, userId, ct);
    }

    // ponytail: no (user_id, updated_at, id) index on vocabulary_words, so a page scans the user's
    // cards; fine for a few thousand words, an index in a V2 migration otherwise (#1047).
    private const string SelectChangedWords = $"""
        SELECT {WordColumns} FROM vocabulary_words
        WHERE user_id = @userId AND (updated_at, id) > (@since, @afterId)
        ORDER BY updated_at, id
        LIMIT @limit
        """;

    public Task<IReadOnlyList<VocabularyWord>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct) =>
        WithExamplesAsync(SelectChangedWords, new { userId, since, afterId, limit }, userId, ct);

    // A tombstone's examples are still live rows (no example delete in V2's first release): the feed
    // carries them, so a restore elsewhere brings the card back whole.
    private const string SelectExamplesOfWords = $"""
        SELECT {ExampleColumns} FROM vocabulary_examples
        WHERE user_id = @userId AND word_id = ANY(@wordIds) AND deleted_at IS NULL
        ORDER BY created_at, id
        """;

    private async Task<IReadOnlyList<VocabularyWord>> WithExamplesAsync(string selectWords, object args, Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var words = (await conn.QueryAsync<VocabularyWord>(new CommandDefinition(selectWords, args, cancellationToken: ct))).AsList();
        if (words.Count == 0) return words;
        var wordIds = words.Select(w => w.Id).ToArray();
        var examples = (await conn.QueryAsync<VocabularyExample>(new CommandDefinition(
            SelectExamplesOfWords, new { userId, wordIds }, cancellationToken: ct))).ToLookup(e => e.WordId);
        foreach (var word in words) word.Examples = examples[word.Id].ToList();
        return words;
    }
}
