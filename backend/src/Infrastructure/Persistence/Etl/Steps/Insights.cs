using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Insights (ADR-031 rows 48, 49): <c>book_insight</c> with <c>edition_id</c>/<c>user_book_id</c> folded into one
/// <c>book_id</c> (the catalog pair's book, or the upload's own id); its <c>review_question</c> rows as they are,
/// the stored <c>prompt_hash</c> included (never recomputed). Conflict rule for both: insert what V2 lacks, leave
/// what is equal; a V2 row that differs is a failed check, never overwritten.
/// </summary>
public static class EtlV2Insights
{
    public static readonly EtlV2Step Step = new("insights", ["book_insight", "review_question", "user_books"], ["book_insight", "review_question"], RunAsync);

    private const string SelectLegacyInsights = """
        SELECT id, user_id, edition_id, user_book_id, chapter_slug, text, question, source, review_json::text AS review_json, created_at, updated_at
        FROM book_insight ORDER BY id
        """;

    private const string SelectLegacyQuestions = """
        SELECT id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at
        FROM review_question ORDER BY id
        """;

    private const string SelectUploadOwners = "SELECT id, user_id FROM user_books";

    private const string SelectV2Insights = """
        SELECT id, user_id, book_id, chapter_slug, text, question, source, review_json::text AS review_json, created_at, updated_at
        FROM book_insight
        """;

    private const string InsertInsight = """
        INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)
        VALUES (@Id, @UserId, @BookId, @ChapterSlug, @Text, @Question, @Source, CAST(@ReviewJson AS jsonb), @CreatedAt, @UpdatedAt)
        """;

    private const string SelectV2Questions = """
        SELECT id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at
        FROM review_question
        """;

    private const string InsertQuestion = """
        INSERT INTO review_question (id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
        VALUES (@Id, @UserId, @BookInsightId, @BlockIndex, @Prompt, @Answer, @PromptHash, @Stage, @IntervalDays, @ConsecutiveCorrect,
            @NextReviewAt, @LastReviewedAt, @TotalReviews, @CorrectReviews, @IsRetired, @CreatedAt, @UpdatedAt)
        """;

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var uploadOwner = (await EtlV2Rows.SourceAsync<(Guid Id, Guid UserId)>(context, SelectUploadOwners, null, ct)).ToDictionary(b => b.Id, b => b.UserId);
        var legacy = EtlV2Rows.Admit(context, "book_insight", await EtlV2Rows.SourceAsync<LegacyInsight>(context, SelectLegacyInsights, null, ct), i => i.Id,
            ("source V2 does not take (only mcp)", i => i.Source != "mcp"),
            ("a review without a chapter", i => i.ReviewJson is not null && i.ChapterSlug is null),
            ("its upload belongs to another user", i => i.UserBookId is { } ub && uploadOwner[ub] != i.UserId));
        // ck_book_insight_target in legacy: exactly one of the two.
        var insights = legacy.Select(i => new InsightRow
        {
            Id = i.Id,
            UserId = i.UserId,
            BookId = i.UserBookId ?? EtlV2Ids.CatalogBook(i.UserId, i.EditionId!.Value),
            ChapterSlug = i.ChapterSlug,
            Text = i.Text,
            Question = i.Question,
            Source = i.Source,
            ReviewJson = i.ReviewJson,
            CreatedAt = i.CreatedAt,
            UpdatedAt = i.UpdatedAt,
        }).ToList();

        // A question of a refused insight is not planned: that insight's check already fails the run.
        var carried = insights.ToDictionary(i => i.Id);
        var questions = EtlV2Rows.Admit(context, "review_question",
            (await EtlV2Rows.SourceAsync<QuestionRow>(context, SelectLegacyQuestions, null, ct)).Where(q => carried.ContainsKey(q.BookInsightId)), q => q.Id,
            ("another user's insight", q => carried[q.BookInsightId].UserId != q.UserId),
            ("negative SRS field", q => q.Stage < 0 || q.IntervalDays < 0 || q.ConsecutiveCorrect < 0));

        var v2Insights = await EtlV2Rows.TargetAsync<InsightRow>(context, SelectV2Insights, null, ct);
        var v2Questions = await EtlV2Rows.TargetAsync<QuestionRow>(context, SelectV2Questions, null, ct);
        var insightPlan = EtlV2Rows.Plan(context, "book_insight", insights, v2Insights, i => i.Id);
        var questionPlan = EtlV2Rows.Plan(context, "review_question", questions, v2Questions, q => q.Id);
        EtlV2Rows.HeldByAnother(context, "book_insight: (user_id, book_id, chapter_slug)", insights, v2Insights, i => i.Id, i => (i.UserId, i.BookId, i.ChapterSlug));
        EtlV2Rows.HeldByAnother(context, "review_question: (user_id, book_insight_id, prompt_hash)", questions, v2Questions, q => q.Id, q => (q.UserId, q.BookInsightId, q.PromptHash));

        if (!context.MayWrite)
            return;
        await using (var tx = await context.BeginWriteAsync(ct))
        {
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertInsight, insightPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertQuestion, questionPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.CommitAsync(ct);
        }

        // Plan §5.2 "insight hashes equal", as every column compared: stricter than a hash of them.
        EtlV2Rows.Verify(context, "book_insight: parity", insights, await EtlV2Rows.TargetAsync<InsightRow>(context, SelectV2Insights, null, ct), i => i.Id);
        EtlV2Rows.Verify(context, "review_question: parity", questions, await EtlV2Rows.TargetAsync<QuestionRow>(context, SelectV2Questions, null, ct), q => q.Id);
    }

    private sealed record LegacyInsight
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid? EditionId { get; init; }
        public Guid? UserBookId { get; init; }
        public string? ChapterSlug { get; init; }
        public string Text { get; init; } = "";
        public string? Question { get; init; }
        public string Source { get; init; } = "";
        public string? ReviewJson { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }

    /// <summary><c>review_json</c> as Postgres prints jsonb, the same on both sides.</summary>
    private sealed record InsightRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public string? ChapterSlug { get; init; }
        public string Text { get; init; } = "";
        public string? Question { get; init; }
        public string Source { get; init; } = "";
        public string? ReviewJson { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }

    /// <summary>The same columns on both sides (legacy minus <c>site_id</c>).</summary>
    private sealed record QuestionRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookInsightId { get; init; }
        public int BlockIndex { get; init; }
        public string Prompt { get; init; } = "";
        public string Answer { get; init; } = "";
        public string PromptHash { get; init; } = "";
        public int Stage { get; init; }
        public double IntervalDays { get; init; }
        public int ConsecutiveCorrect { get; init; }
        public DateTimeOffset NextReviewAt { get; init; }
        public DateTimeOffset? LastReviewedAt { get; init; }
        public int TotalReviews { get; init; }
        public int CorrectReviews { get; init; }
        public bool IsRetired { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }
}
