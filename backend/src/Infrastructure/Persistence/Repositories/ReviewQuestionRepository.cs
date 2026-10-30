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
        // Both on ix_review_question_user_id_is_retired_next_review_at; one round trip.
        const string sql = $"""
            SELECT count(*) FROM review_question
            WHERE user_id = @userId AND NOT is_retired AND next_review_at <= @now;

            SELECT {Columns} FROM review_question
            WHERE user_id = @userId AND NOT is_retired AND next_review_at <= @now
            ORDER BY next_review_at, id
            LIMIT @limit;
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var results = await conn.QueryMultipleAsync(new CommandDefinition(sql, new { userId, now, limit }, cancellationToken: ct));
        var total = await results.ReadSingleAsync<long>();
        var questions = (await results.ReadAsync<ReviewQuestion>()).AsList();
        return new((int)total, questions);
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
        // Checked first, not left to the FK: the FK refuses an insert under another user's insight,
        // but a prompt hash that insight already has would take the ON CONFLICT path and rewrite
        // the other user's question.
        const string owned = "SELECT EXISTS (SELECT 1 FROM book_insight WHERE user_id = @userId AND id = @insightId)";
        // A known hash keeps its schedule and counts; only what the review says changes.
        const string upsert = """
            INSERT INTO review_question (id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
            VALUES (@Id, @userId, @insightId, @BlockIndex, @Prompt, @Answer, @PromptHash, @Stage, @IntervalDays, @ConsecutiveCorrect, @NextReviewAt, NULL, 0, 0, false, now(), now())
            ON CONFLICT (book_insight_id, prompt_hash) DO UPDATE SET
                prompt = EXCLUDED.prompt, answer = EXCLUDED.answer, block_index = EXCLUDED.block_index, updated_at = now()
            """;
        const string deleteGone = """
            DELETE FROM review_question
            WHERE user_id = @userId AND book_insight_id = @insightId AND prompt_hash <> ALL(@hashes)
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        if (!await conn.ExecuteScalarAsync<bool>(new CommandDefinition(owned, new { userId, insightId }, tx, cancellationToken: ct)))
            return false;
        // Dapper runs the statement once per element.
        await conn.ExecuteAsync(new CommandDefinition(upsert, questions.Select(q => new
        {
            q.Id,
            userId,
            insightId,
            q.BlockIndex,
            q.Prompt,
            q.Answer,
            q.PromptHash,
            q.Stage,
            q.IntervalDays,
            q.ConsecutiveCorrect,
            q.NextReviewAt,
        }), tx, cancellationToken: ct));
        var hashes = questions.Select(q => q.PromptHash).ToArray();
        await conn.ExecuteAsync(new CommandDefinition(deleteGone, new { userId, insightId, hashes }, tx, cancellationToken: ct));
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
