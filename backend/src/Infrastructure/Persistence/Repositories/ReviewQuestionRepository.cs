using Application.Discussion;
using Dapper;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IReviewQuestionRepository"/> on <c>textstack_v2</c>. A question
/// is matched across re-saves by <c>ix_review_question_book_insight_id_prompt_hash</c>, and can only
/// belong to an insight of its own user (<c>fk_review_question_book_insight_user_id_book_insight_id</c>).
/// </summary>
public sealed class ReviewQuestionRepository(V2DataSource dataSource) : IReviewQuestionRepository
{
    private const string Columns =
        "id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at";

    public async Task<DueReviewQuestions> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        // On ix_review_question_user_id_is_retired_next_review_at. The window count is taken before
        // LIMIT, so every row carries the number due in all; no row means none is due.
        const string sql = $"""
            SELECT {Columns}, count(*) OVER () AS total FROM review_question
            WHERE user_id = @userId AND NOT is_retired AND next_review_at <= @now
            ORDER BY next_review_at, id
            LIMIT @limit
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<ReviewQuestion, long, (ReviewQuestion Question, long Total)>(
            new CommandDefinition(sql, new { userId, now, limit }, cancellationToken: ct), (q, total) => (q, total), splitOn: "total")).AsList();
        return new(rows.Count == 0 ? 0 : (int)rows[0].Total, rows.Select(r => r.Question).ToList());
    }

    public async Task<ReviewQuestion?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = $"SELECT {Columns} FROM review_question WHERE user_id = @userId AND id = @id";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<ReviewQuestion>(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct));
    }

    public async Task<bool> ReplaceForInsightAsync(
        Guid userId, Guid insightId, IReadOnlyList<ReviewQuestion> questions, CancellationToken ct)
    {
        // FOR UPDATE serializes replaces of one insight: unserialized, two that share hashes in
        // opposite order deadlock, and two disjoint ones leave their union.
        const string owned = "SELECT EXISTS (SELECT 1 FROM book_insight WHERE user_id = @userId AND id = @insightId FOR UPDATE)";
        // One statement for the whole set; the deleted rows (hashes no longer given) and the upserted
        // ones are disjoint. A known hash keeps its schedule and counts, only what the review says
        // changes; the DO UPDATE's WHERE is a second guard against rewriting another user's question.
        const string replace = """
            WITH gone AS (
                DELETE FROM review_question
                WHERE user_id = @userId AND book_insight_id = @insightId AND prompt_hash <> ALL(@hashes))
            INSERT INTO review_question (id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
            SELECT q.id, @userId, @insightId, q.block_index, q.prompt, q.answer, q.prompt_hash, q.stage, q.interval_days, q.consecutive_correct, q.next_review_at, NULL, 0, 0, false, now(), now()
            FROM unnest(@ids, @blockIndexes, @prompts, @answers, @hashes, @stages, @intervalDays, @consecutiveCorrect, @nextReviewAts)
                AS q(id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at)
            ON CONFLICT (book_insight_id, prompt_hash) DO UPDATE SET
                prompt = EXCLUDED.prompt, answer = EXCLUDED.answer, block_index = EXCLUDED.block_index, updated_at = now()
            WHERE review_question.user_id = @userId
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        if (!await conn.ExecuteScalarAsync<bool>(new CommandDefinition(owned, new { userId, insightId }, tx, cancellationToken: ct)))
            return false;
        // One statement cannot update a row twice (21000), so a hash given twice keeps its last question.
        var set = questions.GroupBy(q => q.PromptHash).Select(g => g.Last()).ToList();
        await conn.ExecuteAsync(new CommandDefinition(replace, new
        {
            userId,
            insightId,
            ids = set.Select(q => q.Id).ToArray(),
            blockIndexes = set.Select(q => q.BlockIndex).ToArray(),
            prompts = set.Select(q => q.Prompt).ToArray(),
            answers = set.Select(q => q.Answer).ToArray(),
            hashes = set.Select(q => q.PromptHash).ToArray(),
            stages = set.Select(q => q.Stage).ToArray(),
            intervalDays = set.Select(q => q.IntervalDays).ToArray(),
            consecutiveCorrect = set.Select(q => q.ConsecutiveCorrect).ToArray(),
            // Arrays skip Dapper's UTC handler, and Npgsql writes timestamptz only from offset 0.
            nextReviewAts = set.Select(q => q.NextReviewAt.ToUniversalTime()).ToArray(),
        }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return true;
    }

    public async Task<ReviewQuestion?> RecordAnswerAsync(Guid userId, Guid id, ReviewSchedule schedule, CancellationToken ct)
    {
        const string sql = $"""
            UPDATE review_question SET
                stage = @Stage,
                interval_days = @IntervalDays,
                consecutive_correct = @ConsecutiveCorrect,
                next_review_at = @NextReviewAt,
                last_reviewed_at = @LastReviewedAt,
                total_reviews = @TotalReviews,
                correct_reviews = @CorrectReviews,
                is_retired = @IsRetired,
                updated_at = now()
            WHERE user_id = @userId AND id = @id
            RETURNING {Columns}
            """;
        var args = new DynamicParameters(schedule);
        args.Add("userId", userId);
        args.Add("id", id);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<ReviewQuestion>(new CommandDefinition(sql, args, cancellationToken: ct));
    }
}
