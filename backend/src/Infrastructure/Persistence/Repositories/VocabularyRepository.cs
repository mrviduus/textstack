using Application.Common;
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
    private const string TouchWord = $"UPDATE vocabulary_words SET updated_at = now() WHERE user_id = @UserId AND id = @WordId RETURNING {WordColumns}";
    // Any state: a replay is answered even on a tombstone. The lock serializes every append to one
    // card with its delete and with other appends, so each sees the last one's result.
    private const string LockWord = $"SELECT {WordColumns} FROM vocabulary_words WHERE user_id = @UserId AND id = @WordId FOR UPDATE";

    public async Task<SavedWord> SaveWordAsync(Guid userId, VocabularyWord word, VocabularyExample? example, CancellationToken ct)
    {
        if (word.UserId != userId || (example is not null && example.UserId != userId))
            throw new ArgumentException("The word and its example must belong to the user saving them.", nameof(word));
        // A new card starts on the schema's default schedule. An existing one is never changed by a
        // save: its translation and definition change only through UpdateWordAsync. No arbiter, so
        // every unique key turns into "no row": the word key (the card exists), and the id, which a
        // retry still in flight holds (it waits for it, then finds the card by key) or another card
        // holds (no card under the key: an id conflict).
        const string create = $"""
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key, translation, definition, created_at, updated_at)
            VALUES (@Id, @UserId, @Language, @Word, @WordKey, @Translation, @Definition, now(), now())
            ON CONFLICT DO NOTHING
            RETURNING {WordColumns}
            """;
        const string selectByKey = $"""
            SELECT {WordColumns} FROM vocabulary_words
            WHERE user_id = @UserId AND language = @Language AND word_key = @WordKey
            """;
        // With an example to add, the card is locked, so a delete cannot land between this read and
        // the insert; a plain re-save writes nothing and needs neither a lock nor a transaction.
        const string lockByKey = selectByKey + " FOR UPDATE";

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = example is null ? null : await conn.BeginTransactionAsync(ct);
        var created = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(create, word, tx, cancellationToken: ct));
        var stored = created ?? await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(
            tx is null ? selectByKey : lockByKey, word, tx, cancellationToken: ct));
        if (stored is null) return new SavedWord(WordSaveOutcome.IdConflict, null, null);
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
            // The touch returns the card as it now is, so the caller gets the new updated_at.
            added = outcome == WordSaveOutcome.Deleted
                ? await ReplayAsync<VocabularyExample>(conn, tx!, SelectExampleByOperation, args, example.PayloadSha256, e => e.PayloadSha256, ct)
                : await InsertOnceAsync<VocabularyExample>(conn, tx!, InsertExample, SelectExampleByOperation, args, example.PayloadSha256, e => e.PayloadSha256,
                    async () => stored = await conn.QuerySingleAsync<VocabularyWord>(new CommandDefinition(TouchWord, args, tx, cancellationToken: ct)), ct);
            await tx!.CommitAsync(ct);
        }
        return new SavedWord(outcome, stored, added);
    }

    public async Task<RevisionedWrite<VocabularyWord>> UpdateWordAsync(
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
            if (written is not null) return new RevisionedWrite<VocabularyWord>(true, written);
        }
        return new RevisionedWrite<VocabularyWord>(false, await GetWordAsync(userId, wordId, ct));
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
            ?? await InsertOnceAsync<VocabularyExample>(conn, tx, InsertExample, SelectExampleByOperation, example, example.PayloadSha256, e => e.PayloadSha256,
                () => conn.ExecuteAsync(new CommandDefinition(TouchWord, example, tx, cancellationToken: ct)), ct);
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
            result = await InsertOnceAsync<VocabularyReview>(conn, tx, insert, selectByOperation, args, review.PayloadSha256, r => r.PayloadSha256,
                () => conn.ExecuteAsync(new CommandDefinition(applySchedule, scheduleArgs, tx, cancellationToken: ct)), ct);
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
    /// What a new operation on <paramref name="card"/> gets before anything is written: refused when
    /// the user has no such card or it is a tombstone; null on a live card, which takes it.
    /// </summary>
    private static WriteResult<T>? NewOperationOn<T>(VocabularyWord? card) => card switch
    {
        null => new WriteResult<T>(WriteOutcome.NotFound, default),
        { DeletedAt: not null } => new WriteResult<T>(WriteOutcome.Deleted, default),
        _ => null,
    };

    /// <summary>
    /// Inserts a row keyed by <c>(user_id, operation_id)</c> and runs <paramref name="onCreated"/> on
    /// its card; a concurrent writer that stored the key first turns this into a replay.
    /// </summary>
    private static async Task<WriteResult<T>> InsertOnceAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string insert, string selectByOperation, object args,
        string payloadSha256, Func<T, string> storedSha256, Func<Task> onCreated, CancellationToken ct) where T : class
    {
        // ON CONFLICT saw a row the read then misses only if it was deleted between the two statements
        // (an account delete cascading): try once more. Missing it twice is a broken invariant.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var created = await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(insert, args, tx, cancellationToken: ct));
            if (created is not null)
            {
                await onCreated();
                return new WriteResult<T>(WriteOutcome.Created, created);
            }
            if (await ReplayAsync(conn, tx, selectByOperation, args, payloadSha256, storedSha256, ct) is { } replayed)
                return replayed;
        }
        throw new InvalidOperationException("The operation id conflicted twice with a row that could not be read back.");
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
