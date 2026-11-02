using Application.Vocabulary;
using Domain.Vocabulary;

namespace Infrastructure.Persistence.Repositories;

/// <summary>The merge's vocabulary: step 2 (cards by <c>(language, word_key)</c>) and the example and review hashes of step 7.</summary>
public sealed partial class AccountMergeRepository
{
    private const string SameKey = "a.user_id = @accountId AND g.user_id = @guestId AND a.language = g.language AND a.word_key = g.word_key";

    // The account's tombstone, the guest's live card: the account's id comes back with the guest's
    // card and schedule. Every other pair keeps the account's row as it is.
    private const string ReviveFromGuestCards = $"""
        UPDATE vocabulary_words a SET
            word = g.word, translation = g.translation, definition = g.definition, stage = g.stage,
            interval_days = g.interval_days, consecutive_correct = g.consecutive_correct, next_review_at = g.next_review_at,
            last_reviewed_at = g.last_reviewed_at, retired_at = g.retired_at, deleted_at = NULL
        FROM vocabulary_words g
        WHERE {SameKey} AND a.deleted_at IS NOT NULL AND g.deleted_at IS NULL
        """;

    // Every survivor, revived or not: a revision past both, so every device's cached one is stale.
    private const string BumpSurvivors = $"""
        UPDATE vocabulary_words a SET revision = greatest(a.revision, g.revision) + 1, updated_at = now()
        FROM vocabulary_words g
        WHERE {SameKey}
        RETURNING g.id, a.id
        """;

    // The examples' book FKs are deferred, so they may still name a guest book until step 3 or 4.
    private const string MoveExamplesToSurvivors = """
        UPDATE vocabulary_examples e SET user_id = @accountId, word_id = m.account_word
        FROM unnest(@guestWords, @accountWords) AS m(guest_word, account_word)
        WHERE e.user_id = @guestId AND e.word_id = m.guest_word
        """;

    // A review hashes its word id, so the moved ones are rehashed in step 7.
    private const string MoveReviewsToSurvivors = """
        UPDATE vocabulary_reviews r SET user_id = @accountId, word_id = m.account_word
        FROM unnest(@guestWords, @accountWords) AS m(guest_word, account_word)
        WHERE r.user_id = @guestId AND r.word_id = m.guest_word
        RETURNING r.id
        """;

    private const string DeleteEmptiedGuestCards = "DELETE FROM vocabulary_words WHERE user_id = @guestId AND id = ANY(@guestWords)";

    // The rest keep their ids; the cascade carries their examples and reviews.
    private const string MoveCards = "UPDATE vocabulary_words SET user_id = @accountId, updated_at = now() WHERE user_id = @guestId";

    /// <summary>Step 2. Returns the guest→survivor card map and the reviews that moved to a survivor.</summary>
    private static async Task<(Dictionary<Guid, Guid> Words, List<Guid> Reviews)> MergeWordsAsync(Run run)
    {
        await run.ExecuteAsync(ReviveFromGuestCards);
        var pairs = await run.QueryAsync<(Guid Guest, Guid Account)>(BumpSurvivors);
        var map = new { guestWords = pairs.Select(p => p.Guest).ToArray(), accountWords = pairs.Select(p => p.Account).ToArray() };
        await run.ExecuteAsync(MoveExamplesToSurvivors, map);
        var reviews = await run.QueryAsync<Guid>(MoveReviewsToSurvivors, map);
        await run.ExecuteAsync(DeleteEmptiedGuestCards, map);
        await run.ExecuteAsync(MoveCards);
        return (pairs.ToDictionary(p => p.Guest, p => p.Account), reviews);
    }

    // An example names its card by language and key, which a merge never changes; only its book and file can.
    private const string SelectExamplesToRehash = """
        SELECT e.id, e.book_id, e.file_id, e.chapter_key, e.book_title, e.sentence, e.contextual_translation, w.language, w.word_key
        FROM vocabulary_examples e
        JOIN vocabulary_words w ON w.user_id = e.user_id AND w.id = e.word_id
        WHERE e.user_id = @accountId AND e.id = ANY(@ids)
        """;
    private const string SetExampleHashes = """
        UPDATE vocabulary_examples t SET payload_sha256 = m.hash
        FROM unnest(@ids, @hashes) AS m(id, hash)
        WHERE t.user_id = @accountId AND t.id = m.id
        """;

    private static async Task RehashExamplesAsync(Run run, List<Guid> ids)
    {
        if (ids.Count == 0) return;
        var rows = await run.QueryAsync<VocabularyExample, VocabularyWord, (Guid Id, string Hash)>(SelectExamplesToRehash,
            (e, card) => (e.Id, VocabularyPayloads.ExampleSha256(card, e)), splitOn: "language", new { ids = ids.ToArray() });
        await run.ExecuteAsync(SetExampleHashes, new { ids = rows.Select(r => r.Id).ToArray(), hashes = rows.Select(r => r.Hash).ToArray() });
    }

    private const string SelectReviewsToRehash = """
        SELECT id, word_id, review_mode, is_correct, response_time_ms, client_recorded_at
        FROM vocabulary_reviews WHERE user_id = @accountId AND id = ANY(@ids)
        """;
    private const string SetReviewHashes = """
        UPDATE vocabulary_reviews t SET payload_sha256 = m.hash
        FROM unnest(@ids, @hashes) AS m(id, hash)
        WHERE t.user_id = @accountId AND t.id = m.id
        """;

    private static async Task RehashReviewsAsync(Run run, List<Guid> ids)
    {
        if (ids.Count == 0) return;
        var rows = await run.QueryAsync<VocabularyReview>(SelectReviewsToRehash, new { ids = ids.ToArray() });
        await run.ExecuteAsync(SetReviewHashes,
            new { ids = rows.Select(r => r.Id).ToArray(), hashes = rows.Select(VocabularyPayloads.ReviewSha256).ToArray() });
    }
}
