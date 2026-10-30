using Application.Vocabulary;
using Dapper;
using Domain.Vocabulary;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IVocabularyRepository"/> on <c>textstack_v2</c>. The rules it
/// leans on live in the schema (database/v2/migrations/0000_baseline.up.sql, "Vocabulary"): one card
/// per <c>(user_id, language, word_key)</c>, tombstones included, so a retried save cannot make a
/// second card; one example or review per <c>(user_id, operation_id)</c>; and composite FKs that keep
/// every row on its own user's card, book and file. A card's <c>updated_at</c> is the sync feed's
/// watermark (v2-sync-protocol.md), so every write that changes what the feed shows of a card bumps
/// it; <c>revision</c> moves only on explicit edit, delete and restore.
/// </summary>
public sealed class VocabularyRepository(V2DataSource dataSource) : IVocabularyRepository
{
    private const string WordColumns =
        "id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, created_at, updated_at, deleted_at, revision";
    private const string ExampleColumns =
        "id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at, deleted_at";
    private const string ReviewColumns =
        "id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at";

    private const string InsertExample = $"""
        INSERT INTO vocabulary_examples (id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at)
        VALUES (@Id, @UserId, @WordId, @BookId, @FileId, @ChapterKey, @BookTitle, @Sentence, @ContextualTranslation, @OperationId, @PayloadSha256, now())
        ON CONFLICT (user_id, operation_id) DO NOTHING
        RETURNING {ExampleColumns}
        """;
    private const string SelectExampleByOperation =
        $"SELECT {ExampleColumns} FROM vocabulary_examples WHERE user_id = @UserId AND operation_id = @OperationId";
    private const string TouchWord = "UPDATE vocabulary_words SET updated_at = now() WHERE user_id = @UserId AND id = @WordId";

    public async Task<SavedWord> SaveWordAsync(VocabularyWord word, VocabularyExample? example, CancellationToken ct)
    {
        if (example is not null && example.UserId != word.UserId)
            throw new ArgumentException("The example must belong to the word's user.", nameof(example));
        // A new card starts on the schema's default schedule.
        const string create = $"""
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key, translation, definition, created_at, updated_at)
            VALUES (@Id, @UserId, @Language, @Word, @WordKey, @Translation, @Definition, now(), now())
            ON CONFLICT (user_id, language, word_key) DO NOTHING
            RETURNING {WordColumns}
            """;
        // A live card only takes a translation or definition it lacks; when there is nothing to fill,
        // or the card is a tombstone, the row is left alone and none is returned.
        const string fill = $"""
            UPDATE vocabulary_words SET
                translation = COALESCE(translation, @Translation),
                definition = COALESCE(definition, @Definition),
                updated_at = now()
            WHERE user_id = @UserId AND language = @Language AND word_key = @WordKey AND deleted_at IS NULL
              AND ((translation IS NULL AND @Translation IS NOT NULL) OR (definition IS NULL AND @Definition IS NOT NULL))
            RETURNING {WordColumns}
            """;
        // Locks the card, so a delete cannot land between this read and the example insert.
        const string selectByKey = $"""
            SELECT {WordColumns} FROM vocabulary_words
            WHERE user_id = @UserId AND language = @Language AND word_key = @WordKey
            FOR UPDATE
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var created = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(create, word, tx, cancellationToken: ct));
        var stored = created
            ?? await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(fill, word, tx, cancellationToken: ct))
            ?? await conn.QuerySingleAsync<VocabularyWord>(new CommandDefinition(selectByKey, word, tx, cancellationToken: ct));
        var outcome = created is not null ? WordSaveOutcome.Created
            : stored.DeletedAt is null ? WordSaveOutcome.Existing
            : WordSaveOutcome.Deleted;
        WriteResult<VocabularyExample>? added = null;
        if (example is not null && outcome != WordSaveOutcome.Deleted)
        {
            example.WordId = stored.Id;
            added = await InsertOnceAsync(conn, tx, InsertExample, SelectExampleByOperation, example, e => e.PayloadSha256, TouchWord, example, ct);
        }
        await tx.CommitAsync(ct);
        return new SavedWord(outcome, stored, added);
    }

    public async Task<UpdateWordResult> UpdateWordAsync(
        Guid userId, Guid wordId, string? translation, string? definition, long expectedRevision, CancellationToken ct)
    {
        const string sql = $"""
            UPDATE vocabulary_words SET translation = @translation, definition = @definition, updated_at = now(), revision = revision + 1
            WHERE user_id = @userId AND id = @wordId AND revision = @expectedRevision AND deleted_at IS NULL
            RETURNING {WordColumns}
            """;
        await using (var conn = await dataSource.OpenConnectionAsync(ct))
        {
            var written = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(
                sql, new { userId, wordId, translation, definition, expectedRevision }, cancellationToken: ct));
            if (written is not null) return new UpdateWordResult(true, written);
        }
        return new UpdateWordResult(false, await GetWordAsync(userId, wordId, ct));
    }

    public async Task<bool> DeleteWordAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        const string sql = """
            UPDATE vocabulary_words SET deleted_at = now(), updated_at = now(), revision = revision + 1
            WHERE user_id = @userId AND id = @wordId AND deleted_at IS NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, wordId }, cancellationToken: ct)) > 0;
    }

    public async Task<bool> RestoreWordAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        const string sql = """
            UPDATE vocabulary_words SET deleted_at = NULL, updated_at = now(), revision = revision + 1
            WHERE user_id = @userId AND id = @wordId AND deleted_at IS NOT NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, wordId }, cancellationToken: ct)) > 0;
    }

    public async Task<VocabularyWord?> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        const string sql = $"""
            SELECT {WordColumns} FROM vocabulary_words WHERE user_id = @userId AND id = @wordId;
            SELECT {ExampleColumns} FROM vocabulary_examples
            WHERE user_id = @userId AND word_id = @wordId AND deleted_at IS NULL
            ORDER BY created_at, id;
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var results = await conn.QueryMultipleAsync(new CommandDefinition(sql, new { userId, wordId }, cancellationToken: ct));
        var word = await results.ReadSingleOrDefaultAsync<VocabularyWord>();
        if (word is not null) word.Examples = (await results.ReadAsync<VocabularyExample>()).AsList();
        return word;
    }

    public Task<WriteResult<VocabularyExample>> AddExampleAsync(VocabularyExample example, CancellationToken ct) =>
        AppendOnceAsync(InsertExample, SelectExampleByOperation, example, e => e.PayloadSha256, TouchWord, example, ct);

    public Task<WriteResult<VocabularyReview>> RecordReviewAsync(
        VocabularyReview review, ReviewSchedule newSchedule, CancellationToken ct)
    {
        const string insert = $"""
            INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at)
            VALUES (@Id, @UserId, @WordId, @OperationId, @PayloadSha256, @ReviewMode, @IsCorrect, @ResponseTimeMs, @StageBefore, @StageAfter, @ClientRecordedAt, now())
            ON CONFLICT (user_id, operation_id) DO NOTHING
            RETURNING {ReviewColumns}
            """;
        const string selectByOperation =
            $"SELECT {ReviewColumns} FROM vocabulary_reviews WHERE user_id = @UserId AND operation_id = @OperationId";
        // A schedule is not an edit of the card: revision stays, so a device's pending edit still applies.
        const string applySchedule = """
            UPDATE vocabulary_words SET
                stage = @Stage,
                interval_days = @IntervalDays,
                consecutive_correct = @ConsecutiveCorrect,
                next_review_at = @NextReviewAt,
                last_reviewed_at = @ClientRecordedAt,
                updated_at = now()
            WHERE user_id = @UserId AND id = @WordId
            """;
        var scheduleArgs = new
        {
            review.UserId,
            review.WordId,
            review.ClientRecordedAt,
            newSchedule.Stage,
            newSchedule.IntervalDays,
            newSchedule.ConsecutiveCorrect,
            newSchedule.NextReviewAt,
        };
        return AppendOnceAsync(insert, selectByOperation, review, r => r.PayloadSha256, applySchedule, scheduleArgs, ct);
    }

    public async Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct)
    {
        // Matches the partial index ix_vocabulary_words_user_id_next_review_at (live cards by due time).
        const string sql = $"""
            SELECT {WordColumns} FROM vocabulary_words
            WHERE user_id = @userId AND deleted_at IS NULL AND next_review_at <= @now
            ORDER BY next_review_at, id
            LIMIT @limit
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<VocabularyWord>(new CommandDefinition(sql, new { userId, now, limit }, cancellationToken: ct))).AsList();
    }

    /// <summary>
    /// An example or review appended to a card by id, in one transaction. A replay is answered first,
    /// even when the card has been deleted since; only a new operation needs a live card.
    /// </summary>
    private async Task<WriteResult<T>> AppendOnceAsync<T>(
        string insert, string selectByOperation, T row, Func<T, string> payloadSha256,
        string onCreated, object onCreatedArgs, CancellationToken ct) where T : class
    {
        // Locks the card against a concurrent delete. No row: not the user's card, which the insert's
        // composite FK then refuses as a broken invariant.
        const string isDeleted = """
            SELECT deleted_at IS NOT NULL FROM vocabulary_words
            WHERE user_id = @UserId AND id = @WordId
            FOR UPDATE
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var replayed = await ReplayAsync(conn, tx, selectByOperation, row, payloadSha256, ct);
        if (replayed is not null) return replayed;
        if (await conn.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(isDeleted, onCreatedArgs, tx, cancellationToken: ct)) == true)
            return new WriteResult<T>(WriteOutcome.Deleted, null);
        var result = await InsertOnceAsync(conn, tx, insert, selectByOperation, row, payloadSha256, onCreated, onCreatedArgs, ct);
        await tx.CommitAsync(ct);
        return result;
    }

    /// <summary>
    /// Inserts a row keyed by <c>(user_id, operation_id)</c> and runs <paramref name="onCreated"/> on
    /// its card; a concurrent writer that stored the key first turns this into a replay.
    /// </summary>
    private static async Task<WriteResult<T>> InsertOnceAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string insert, string selectByOperation, T row,
        Func<T, string> payloadSha256, string onCreated, object onCreatedArgs, CancellationToken ct) where T : class
    {
        var created = await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(insert, row, tx, cancellationToken: ct));
        if (created is null) return (await ReplayAsync(conn, tx, selectByOperation, row, payloadSha256, ct))!;
        await conn.ExecuteAsync(new CommandDefinition(onCreated, onCreatedArgs, tx, cancellationToken: ct));
        return new WriteResult<T>(WriteOutcome.Created, created);
    }

    /// <summary>The stored row under the operation id, told apart from a reused id by its payload hash; null when none.</summary>
    private static async Task<WriteResult<T>?> ReplayAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string selectByOperation, T row, Func<T, string> payloadSha256,
        CancellationToken ct) where T : class
    {
        var stored = await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(selectByOperation, row, tx, cancellationToken: ct));
        if (stored is null) return null;
        var outcome = payloadSha256(stored) == payloadSha256(row) ? WriteOutcome.Replayed : WriteOutcome.OperationConflict;
        return new WriteResult<T>(outcome, stored);
    }
}
