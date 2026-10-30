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
/// every row on its own user's card, book and file.
/// </summary>
public sealed class VocabularyRepository(V2DataSource dataSource) : IVocabularyRepository
{
    private const string WordColumns =
        "id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, created_at, updated_at, deleted_at, revision";
    // The example insert's column list is this one minus deleted_at; the two must agree.
    private const string ExampleColumns =
        "id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at, deleted_at";
    private const string ReviewColumns =
        "id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at";

    private const string SelectWordById = $"SELECT {WordColumns} FROM vocabulary_words WHERE user_id = @userId AND id = @wordId";
    // Any state: a tombstone still answers replays. The lock serializes every append to one card
    // with its delete and with other appends, so each sees the last one's result.
    private const string LockWord = $"SELECT {WordColumns} FROM vocabulary_words WHERE user_id = @UserId AND id = @WordId FOR UPDATE";

    public async Task<SavedWord> SaveWordAsync(Guid userId, VocabularyWord word, CancellationToken ct)
    {
        if (word.UserId != userId)
            throw new ArgumentException("The word must belong to the user saving it.", nameof(word));
        // No arbiter, so every unique key turns into "no row": the word key (the card exists), and the
        // id, which a retry still in flight holds (it waits for it, then finds the card by key) or
        // another card holds (no card under the key: an id conflict).
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

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        if (await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(create, word, cancellationToken: ct)) is { } created)
            return new SavedWord(WordSaveOutcome.Created, created);
        var stored = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(selectByKey, word, cancellationToken: ct));
        return stored switch
        {
            null => new SavedWord(WordSaveOutcome.IdConflict, null),
            { DeletedAt: not null } => new SavedWord(WordSaveOutcome.Deleted, stored),
            _ => new SavedWord(WordSaveOutcome.Existing, stored),
        };
    }

    public async Task<RevisionedWrite<VocabularyWord>> UpdateWordAsync(
        Guid userId, Guid wordId, string? translation, string? definition, long expectedRevision, CancellationToken ct)
    {
        const string sql = $"""
            UPDATE vocabulary_words SET translation = @translation, definition = @definition, updated_at = now(), revision = revision + 1
            WHERE user_id = @userId AND id = @wordId AND revision = @expectedRevision AND deleted_at IS NULL
            RETURNING {WordColumns}
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var written = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(
            sql, new { userId, wordId, translation, definition, expectedRevision }, cancellationToken: ct));
        return written is not null
            ? new RevisionedWrite<VocabularyWord>(true, written)
            : new RevisionedWrite<VocabularyWord>(false, await conn.QuerySingleOrDefaultAsync<VocabularyWord>(
                new CommandDefinition(SelectWordById, new { userId, wordId }, cancellationToken: ct)));
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
        const string sql = SelectWordById + $"""
            ;
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
        const string upsert = $"""
            WITH ins AS (
                INSERT INTO vocabulary_examples (id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at)
                VALUES (@Id, @UserId, @WordId, @BookId, @FileId, @ChapterKey, @BookTitle, @Sentence, @ContextualTranslation, @OperationId, @PayloadSha256, now())
                ON CONFLICT (user_id, operation_id) DO UPDATE SET operation_id = EXCLUDED.operation_id
                RETURNING {ExampleColumns}, (xmax = 0) AS inserted
            ), touch AS (
                UPDATE vocabulary_words SET updated_at = now()
                WHERE user_id = @UserId AND id = @WordId AND EXISTS (SELECT FROM ins WHERE inserted)
            )
            SELECT {ExampleColumns}, inserted FROM ins
            """;
        const string selectByOperation =
            $"SELECT {ExampleColumns} FROM vocabulary_examples WHERE user_id = @UserId AND operation_id = @OperationId";

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var card = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(LockWord, example, tx, cancellationToken: ct));
        var result = card switch
        {
            null => new WriteResult<VocabularyExample>(WriteOutcome.NotFound, null),
            { DeletedAt: not null } => await ReplayAsync<VocabularyExample>(conn, tx, selectByOperation, example, example.PayloadSha256, e => e.PayloadSha256, ct)
                ?? new WriteResult<VocabularyExample>(WriteOutcome.Deleted, null),
            _ => await UpsertOnceAsync<VocabularyExample>(conn, tx, upsert, example, example.PayloadSha256, e => e.PayloadSha256, ct),
        };
        await tx.CommitAsync(ct);
        return result;
    }

    public async Task<WriteResult<VocabularyReview>> RecordReviewAsync(
        Guid userId, VocabularyReview review, Func<VocabularyWord, ReviewSchedule> schedule, CancellationToken ct)
    {
        if (review.UserId != userId)
            throw new ArgumentException("The review must belong to the user recording it.", nameof(review));
        // The due time is the server's: its clock plus the interval (ADR-031 rule 7). An answer recorded
        // offline and synced late does not move last_reviewed_at back.
        const string upsert = $"""
            WITH ins AS (
                INSERT INTO vocabulary_reviews ({ReviewColumns})
                VALUES (@Id, @UserId, @WordId, @OperationId, @PayloadSha256, @ReviewMode, @IsCorrect, @ResponseTimeMs, @StageBefore, @StageAfter, @ClientRecordedAt, now())
                ON CONFLICT (user_id, operation_id) DO UPDATE SET operation_id = EXCLUDED.operation_id
                RETURNING {ReviewColumns}, (xmax = 0) AS inserted
            ), schedule AS (
                UPDATE vocabulary_words SET
                    stage = @Stage,
                    interval_days = @IntervalDays,
                    consecutive_correct = @ConsecutiveCorrect,
                    next_review_at = now() + CAST(@IntervalDays AS double precision) * interval '1 day',
                    last_reviewed_at = GREATEST(last_reviewed_at, @ClientRecordedAt),
                    updated_at = now()
                WHERE user_id = @UserId AND id = @WordId AND EXISTS (SELECT FROM ins WHERE inserted)
            )
            SELECT {ReviewColumns}, inserted FROM ins
            """;
        const string selectByOperation =
            $"SELECT {ReviewColumns} FROM vocabulary_reviews WHERE user_id = @UserId AND operation_id = @OperationId";

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var card = await conn.QuerySingleOrDefaultAsync<VocabularyWord>(new CommandDefinition(LockWord, review, tx, cancellationToken: ct));
        WriteResult<VocabularyReview> result;
        if (card is null)
            result = new WriteResult<VocabularyReview>(WriteOutcome.NotFound, null);
        else if (card.DeletedAt is not null)
            result = await ReplayAsync<VocabularyReview>(conn, tx, selectByOperation, review, review.PayloadSha256, r => r.PayloadSha256, ct)
                ?? new WriteResult<VocabularyReview>(WriteOutcome.Deleted, null);
        else
        {
            var next = schedule(card);
            review.StageBefore = card.Stage;
            review.StageAfter = next.Stage;
            var args = new DynamicParameters(review);
            args.AddDynamicParams(next);
            result = await UpsertOnceAsync<VocabularyReview>(conn, tx, upsert, args, review.PayloadSha256, r => r.PayloadSha256, ct);
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
    /// Runs an upsert keyed by <c>(user_id, operation_id)</c> whose no-op <c>DO UPDATE</c> returns the
    /// stored row when the key is taken, and whose <c>inserted</c> column (<c>xmax = 0</c>) says
    /// whether this statement created it; a taken key is a replay or, by its payload hash, a conflict.
    /// </summary>
    private static async Task<WriteResult<T>> UpsertOnceAsync<T>(
        NpgsqlConnection conn, NpgsqlTransaction tx, string upsert, object args,
        string payloadSha256, Func<T, string> storedSha256, CancellationToken ct)
    {
        await using var reader = await conn.ExecuteReaderAsync(new CommandDefinition(upsert, args, tx, cancellationToken: ct));
        var parse = reader.GetRowParser<T>();
        await reader.ReadAsync(ct);
        var row = parse(reader);
        var outcome = reader.GetBoolean(reader.GetOrdinal("inserted")) ? WriteOutcome.Created
            : storedSha256(row) == payloadSha256 ? WriteOutcome.Replayed
            : WriteOutcome.OperationConflict;
        return new WriteResult<T>(outcome, row);
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
