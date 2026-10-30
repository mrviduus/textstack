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
    // Any state: a replay is answered even on a tombstone. The lock serializes every append to one
    // card with its delete and with other appends, so each sees the last one's result.
    private const string LockWord = $"SELECT {WordColumns} FROM vocabulary_words WHERE user_id = @UserId AND id = @WordId FOR UPDATE";

    public async Task<SavedWord> SaveWordAsync(Guid userId, VocabularyWord word, VocabularyExample? example, CancellationToken ct)
    {
        if (word.UserId != userId || (example is not null && example.UserId != userId))
            throw new ArgumentException("The word and its example must belong to the user saving them.", nameof(word));
        try
        {
            return await TrySaveWordAsync(word, example, ct);
        }
        // The same save retried while the first is in flight: ON CONFLICT covers the word key, not
        // the primary key, so the retry can trip pk_vocabulary_words. Run again: the card is then stored.
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation && e.ConstraintName == "pk_vocabulary_words")
        {
            return await TrySaveWordAsync(word, example, ct);
        }
    }

    private async Task<SavedWord> TrySaveWordAsync(VocabularyWord word, VocabularyExample? example, CancellationToken ct)
    {
        // A new card starts on the schema's default schedule. An existing one is never changed by a
        // save: its translation and definition change only through UpdateWordAsync.
        const string create = $"""
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key, translation, definition, created_at, updated_at)
            VALUES (@Id, @UserId, @Language, @Word, @WordKey, @Translation, @Definition, now(), now())
            ON CONFLICT (user_id, language, word_key) DO NOTHING
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
        var stored = created ?? await conn.QuerySingleAsync<VocabularyWord>(new CommandDefinition(selectByKey, word, tx, cancellationToken: ct));
        var outcome = created is not null ? WordSaveOutcome.Created
            : stored.DeletedAt is null ? WordSaveOutcome.Existing
            : WordSaveOutcome.Deleted;
        WriteResult<VocabularyExample>? added = null;
        if (example is not null)
        {
            // The example goes on the stored card, whatever the caller's WordId says.
            var args = new
            {
                example.Id,
                example.UserId,
                WordId = stored.Id,
                example.BookId,
                example.FileId,
                example.ChapterKey,
                example.BookTitle,
                example.Sentence,
                example.ContextualTranslation,
                example.OperationId,
                example.PayloadSha256,
            };
            // A tombstone takes no example, but a replay of one it took before is still answered.
            added = outcome == WordSaveOutcome.Deleted
                ? await ReplayAsync<VocabularyExample>(conn, tx, SelectExampleByOperation, args, example.PayloadSha256, e => e.PayloadSha256, ct)
                : await InsertOnceAsync<VocabularyExample>(conn, tx, InsertExample, SelectExampleByOperation, args, example.PayloadSha256, e => e.PayloadSha256, TouchWord, args, ct);
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

    public async Task<WriteResult<VocabularyExample>> AddExampleAsync(Guid userId, VocabularyExample example, CancellationToken ct)
    {
        if (example.UserId != userId)
            throw new ArgumentException("The example must belong to the user adding it.", nameof(example));
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var card = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(LockWord, example, tx, cancellationToken: ct));
        var result = await ReplayAsync<VocabularyExample>(conn, tx, SelectExampleByOperation, example, example.PayloadSha256, e => e.PayloadSha256, ct)
            ?? NewOperationOn<VocabularyExample>(card)
            ?? await InsertOnceAsync<VocabularyExample>(conn, tx, InsertExample, SelectExampleByOperation, example, example.PayloadSha256, e => e.PayloadSha256, TouchWord, example, ct);
        await tx.CommitAsync(ct);
        return result;
    }

    public async Task<WriteResult<VocabularyReview>> RecordReviewAsync(
        Guid userId, VocabularyReview review, Func<VocabularyWord, ReviewSchedule> schedule, CancellationToken ct)
    {
        if (review.UserId != userId)
            throw new ArgumentException("The review must belong to the user recording it.", nameof(review));
        const string insert = $"""
            INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at)
            VALUES (@Id, @UserId, @WordId, @OperationId, @PayloadSha256, @ReviewMode, @IsCorrect, @ResponseTimeMs, @StageBefore, @StageAfter, @ClientRecordedAt, now())
            ON CONFLICT (user_id, operation_id) DO NOTHING
            RETURNING {ReviewColumns}
            """;
        const string selectByOperation =
            $"SELECT {ReviewColumns} FROM vocabulary_reviews WHERE user_id = @UserId AND operation_id = @OperationId";
        // A schedule is not an edit of the card: revision stays, so a device's pending edit still
        // applies. An answer recorded offline and synced late does not move last_reviewed_at back.
        const string applySchedule = """
            UPDATE vocabulary_words SET
                stage = @Stage,
                interval_days = @IntervalDays,
                consecutive_correct = @ConsecutiveCorrect,
                next_review_at = @NextReviewAt,
                last_reviewed_at = GREATEST(last_reviewed_at, @ClientRecordedAt),
                updated_at = now()
            WHERE user_id = @UserId AND id = @WordId
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var card = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(LockWord, review, tx, cancellationToken: ct));
        var result = await ReplayAsync<VocabularyReview>(conn, tx, selectByOperation, review, review.PayloadSha256, r => r.PayloadSha256, ct)
            ?? NewOperationOn<VocabularyReview>(card);
        if (result is null)
        {
            // Computed from the locked card, so two answers in flight each see the other's result.
            var next = schedule(card!);
            var args = new
            {
                review.Id,
                review.UserId,
                review.WordId,
                review.OperationId,
                review.PayloadSha256,
                review.ReviewMode,
                review.IsCorrect,
                review.ResponseTimeMs,
                StageBefore = card!.Stage,
                StageAfter = next.Stage,
                review.ClientRecordedAt,
            };
            var scheduleArgs = new
            {
                review.UserId,
                review.WordId,
                review.ClientRecordedAt,
                next.Stage,
                next.IntervalDays,
                next.ConsecutiveCorrect,
                next.NextReviewAt,
            };
            result = await InsertOnceAsync<VocabularyReview>(conn, tx, insert, selectByOperation, args, review.PayloadSha256, r => r.PayloadSha256, applySchedule, scheduleArgs, ct);
        }
        await tx.CommitAsync(ct);
        return result;
    }

    public async Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
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
    /// What a new operation on <paramref name="card"/> gets before anything is written: refused on a
    /// tombstone; null on a live card, which takes it.
    /// </summary>
    /// <exception cref="ArgumentException">The card is not the user's.</exception>
    private static WriteResult<T>? NewOperationOn<T>(VocabularyWord? card) => card switch
    {
        null => throw new ArgumentException("The card is not the user's."),
        { DeletedAt: not null } => new WriteResult<T>(WriteOutcome.Deleted, default),
        _ => null,
    };

    /// <summary>
    /// Inserts a row keyed by <c>(user_id, operation_id)</c> and runs <paramref name="onCreated"/> on
    /// its card; a concurrent writer that stored the key first turns this into a replay.
    /// </summary>
    private static async Task<WriteResult<T>> InsertOnceAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string insert, string selectByOperation, object args,
        string payloadSha256, Func<T, string> storedSha256, string onCreated, object onCreatedArgs, CancellationToken ct) where T : class
    {
        var created = await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(insert, args, tx, cancellationToken: ct));
        if (created is null) return (await ReplayAsync(conn, tx, selectByOperation, args, payloadSha256, storedSha256, ct))!;
        await conn.ExecuteAsync(new CommandDefinition(onCreated, onCreatedArgs, tx, cancellationToken: ct));
        return new WriteResult<T>(WriteOutcome.Created, created);
    }

    /// <summary>The stored row under the operation id, told apart from a reused id by its payload hash; null when none.</summary>
    private static async Task<WriteResult<T>?> ReplayAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string selectByOperation, object args,
        string payloadSha256, Func<T, string> storedSha256, CancellationToken ct) where T : class
    {
        var stored = await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(selectByOperation, args, tx, cancellationToken: ct));
        if (stored is null) return null;
        var outcome = storedSha256(stored) == payloadSha256 ? WriteOutcome.Replayed : WriteOutcome.OperationConflict;
        return new WriteResult<T>(outcome, stored);
    }
}
