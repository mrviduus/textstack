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
        UPDATE vocabulary_words a SET revision = greatest(a.revision, g.revision) + 1, updated_at = clock_timestamp()
        FROM vocabulary_words g
        WHERE {SameKey}
        RETURNING g.id, a.id
        """;

    // The examples' book FKs are deferred, so they may still name a guest book until step 3 or 4.
    private const string MoveExamplesToSurvivors = $"""
        UPDATE vocabulary_examples e SET user_id = @accountId, word_id = a.id
        FROM vocabulary_words g, vocabulary_words a
        WHERE {SameKey} AND e.user_id = @guestId AND e.word_id = g.id
        """;

    // A review hashes its word id: the moved ones come back as step 7 rehashes them.
    private const string MoveReviewsToSurvivors = $"""
        UPDATE vocabulary_reviews r SET user_id = @accountId, word_id = a.id
        FROM vocabulary_words g, vocabulary_words a
        WHERE {SameKey} AND r.user_id = @guestId AND r.word_id = g.id
        RETURNING r.id, r.word_id, r.review_mode, r.is_correct, r.response_time_ms, r.client_recorded_at
        """;

    // Emptied by the two moves above.
    private const string DeleteEmptiedGuestCards = $"DELETE FROM vocabulary_words g USING vocabulary_words a WHERE {SameKey}";

    // The rest keep their ids; the cascade carries their examples and reviews.
    private const string MoveCards = "UPDATE vocabulary_words SET user_id = @accountId, updated_at = clock_timestamp() WHERE user_id = @guestId";

    // An example names its card by language and key, which a merge never changes; only its book and file can.
    private const string SelectExamplesToRehash = """
        SELECT e.id, e.book_id, e.file_id, e.chapter_key, e.book_title, e.sentence, e.contextual_translation, w.language, w.word_key
        FROM vocabulary_examples e
        JOIN vocabulary_words w ON w.user_id = e.user_id AND w.id = e.word_id
        WHERE e.user_id = @accountId AND e.id = ANY(@exampleIds)
        """;

    private const string SetHashesTail = "AS m(id, hash) WHERE t.user_id = @accountId AND t.id = m.id";
    private const string SetExampleHashes = $"UPDATE vocabulary_examples t SET payload_sha256 = m.hash FROM unnest(@exampleIds, @exampleHashes) {SetHashesTail}";
    private const string SetReviewHashes = $"UPDATE vocabulary_reviews t SET payload_sha256 = m.hash FROM unnest(@reviewIds, @reviewHashes) {SetHashesTail}";
}
