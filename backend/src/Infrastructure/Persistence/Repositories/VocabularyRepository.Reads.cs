using Dapper;
using Domain.Vocabulary;

namespace Infrastructure.Persistence.Repositories;

/// <summary>The reads of <see cref="VocabularyRepository"/>: one card, the review queue and the feed, each card with its live examples.</summary>
public sealed partial class VocabularyRepository
{
    private const string SelectWordWithExamples = SelectWordById + $"""
        ;
        SELECT {ExampleReadColumns} FROM vocabulary_examples
        WHERE user_id = @userId AND word_id = @wordId AND deleted_at IS NULL
        ORDER BY created_at, id;
        """;

    public async Task<VocabularyWord?> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var results = await conn.QueryMultipleAsync(new CommandDefinition(SelectWordWithExamples, new { userId, wordId }, cancellationToken: ct));
        var word = await results.ReadSingleOrDefaultAsync<VocabularyWord>();
        if (word is not null) word.Examples = (await results.ReadAsync<VocabularyExample>()).AsList();
        return word;
    }

    public async Task<VocabularyWord?> GetCardAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(SelectWordById, new { userId, wordId }, cancellationToken: ct));
    }

    // Matches the partial index ix_vocabulary_words_user_id_next_review_at (live, unretired cards by due time).
    // now(), not the api's clock: next_review_at is stamped by the database (data-access.md rule 11).
    private const string SelectDueWords = $"""
        SELECT {WordColumns} FROM vocabulary_words
        WHERE user_id = @userId AND deleted_at IS NULL AND retired_at IS NULL AND next_review_at <= now()
        ORDER BY next_review_at, id
        LIMIT @limit
        """;

    public async Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, int limit, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        return await PageWithExamplesAsync(SelectDueWords, new { userId, limit }, userId, ct);
    }

    private const string SelectChangedWords = $"""
        SELECT {WordColumns} FROM vocabulary_words
        WHERE user_id = @userId AND (updated_at, id) > (@since, @afterId)
        ORDER BY updated_at, id
        LIMIT @limit
        """;

    public Task<IReadOnlyList<VocabularyWord>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct) =>
        PageWithExamplesAsync(SelectChangedWords, new { userId, since, afterId, limit }, userId, ct);

    // A tombstone's examples are still live rows (no example delete in V2's first release): the feed
    // carries them, so a restore elsewhere brings the card back whole. In index order; per card, oldest first.
    private const string SelectExamplesOfWords = $"""
        SELECT {ExampleReadColumns} FROM vocabulary_examples
        WHERE user_id = @userId AND word_id = ANY(@wordIds) AND deleted_at IS NULL
        ORDER BY word_id, created_at, id
        """;

    /// <summary>A page of cards, then the whole page's examples in one statement (never one per card).</summary>
    private async Task<IReadOnlyList<VocabularyWord>> PageWithExamplesAsync(string selectWords, object args, Guid userId, CancellationToken ct)
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
