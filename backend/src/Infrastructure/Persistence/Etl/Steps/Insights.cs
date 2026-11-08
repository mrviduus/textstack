using Application.Common;
using Dapper;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// M3.3 insights (ADR-031 #48, #49): <c>book_insight</c> with <c>edition_id</c>/<c>user_book_id</c>
/// folded into one <c>book_id</c> (the catalog pair's book, or the upload's own id); its
/// <c>review_question</c> rows as they are, the stored <c>prompt_hash</c> included (never recomputed).
/// </summary>
public static class EtlV2Insights
{
    public static readonly string[] SourceTables = ["book_insight", "review_question", "user_books"];

    public static readonly string[] TargetTables = ["book_insight", "review_question"];

    public static readonly EtlV2Step Step = new("insights", RunAsync);

    private const string LegacyInsights = """
        SELECT id, user_id, edition_id, user_book_id, chapter_slug, text, question, source, review_json::text AS review_json, created_at, updated_at
        FROM book_insight ORDER BY id
        """;

    private const string LegacyQuestions = """
        SELECT id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at
        FROM review_question ORDER BY id
        """;

    private const string UploadOwners = "SELECT id, user_id FROM user_books";

    private const string SelectInsights = """
        SELECT id, user_id, book_id, chapter_slug, text, question, source, review_json::text AS review_json, created_at, updated_at
        FROM book_insight WHERE id = ANY(@ids)
        """;

    private const string InsertInsight = """
        INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)
        VALUES (@Id, @UserId, @BookId, @ChapterSlug, @Text, @Question, @Source, CAST(@ReviewJson AS jsonb), @CreatedAt, @UpdatedAt)
        """;

    private const string SelectQuestions = """
        SELECT id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at
        FROM review_question WHERE id = ANY(@ids)
        """;

    private const string InsertQuestion = """
        INSERT INTO review_question (id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
        VALUES (@Id, @UserId, @BookInsightId, @BlockIndex, @Prompt, @Answer, @PromptHash, @Stage, @IntervalDays, @ConsecutiveCorrect,
            @NextReviewAt, @LastReviewedAt, @TotalReviews, @CorrectReviews, @IsRetired, @CreatedAt, @UpdatedAt)
        """;

    private static Task RunAsync(EtlV2Context context, CancellationToken ct) => EtlV2Rows.InTargetAsync(context, async tx =>
    {
        var source = context.Source;
        var users = await EtlV2Rows.KnownUsersAsync(context, tx, ct);
        var legacy = (await source.Connection!.QueryAsync<LegacyInsight>(new CommandDefinition(LegacyInsights, transaction: source, cancellationToken: ct))).AsList();
        var questions = (await source.Connection!.QueryAsync<Question>(new CommandDefinition(LegacyQuestions, transaction: source, cancellationToken: ct))).AsList();
        var uploadOwner = (await source.Connection!.QueryAsync<(Guid Id, Guid UserId)>(new CommandDefinition(UploadOwners, transaction: source, cancellationToken: ct)))
            .ToDictionary(b => b.Id, b => b.UserId);

        var insights = new List<Insight>();
        var orphans = new List<(Guid, string)>();
        var unmappable = new List<(Guid, string)>();
        foreach (var i in legacy)
        {
            var reason = i.Source != "mcp" ? "source is not mcp"
                : i.ReviewJson is not null && i.ChapterSlug is null ? "a review without a chapter"
                : i.UserBookId is { } ub && uploadOwner[ub] != i.UserId ? "its upload belongs to another user"
                : null;
            if (!users.Contains(i.UserId))
                orphans.Add((i.Id, $"user {i.UserId} is not in the target"));
            else if (reason is not null)
                unmappable.Add((i.Id, reason));
            else
                insights.Add(new Insight
                {
                    Id = i.Id,
                    UserId = i.UserId,
                    // ck_book_insight_target: exactly one of the two.
                    BookId = i.UserBookId ?? EtlV2Ids.CatalogBook(i.UserId, i.EditionId!.Value),
                    ChapterSlug = i.ChapterSlug,
                    Text = i.Text,
                    Question = i.Question,
                    Source = i.Source,
                    ReviewJson = i.ReviewJson,
                    CreatedAt = i.CreatedAt,
                    UpdatedAt = i.UpdatedAt,
                });
        }
        EtlV2Rows.Orphans(context, "book_insight", orphans);
        EtlV2Rows.Unmappable(context, "book_insight", unmappable);

        var carried = insights.ToDictionary(i => i.Id);
        EtlV2Rows.Orphans(context, "review_question", questions.Where(q => !carried.ContainsKey(q.BookInsightId))
            .Select(q => (q.Id, $"its insight {q.BookInsightId} is not carried")));
        var planned = new List<Question>();
        var badQuestions = new List<(Guid, string)>();
        foreach (var q in questions.Where(q => carried.ContainsKey(q.BookInsightId)))
        {
            var reason = carried[q.BookInsightId].UserId != q.UserId ? "another user's insight"
                : q.Stage < 0 || q.IntervalDays < 0 || q.ConsecutiveCorrect < 0 ? "negative SRS field"
                : null;
            if (reason is null) planned.Add(q);
            else badQuestions.Add((q.Id, reason));
        }
        EtlV2Rows.Unmappable(context, "review_question", badQuestions);

        await EtlV2Rows.ConvergeAsync(context, tx, "book_insight", insights, i => i.Id, SelectInsights, InsertInsight, ct);
        await EtlV2Rows.ConvergeAsync(context, tx, "review_question", planned, q => q.Id, SelectQuestions, InsertQuestion, ct);
        if (context.DryRun)
            return;

        // A content hash per row (canonical JSON of every mapped column), source mapping vs target.
        var storedInsights = await EtlV2Rows.ReadAsync<Insight>(tx, SelectInsights, [.. insights.Select(i => i.Id)], i => i.Id, ct);
        var storedQuestions = await EtlV2Rows.ReadAsync<Question>(tx, SelectQuestions, [.. planned.Select(q => q.Id)], q => q.Id, ct);
        context.Checks.Add(new("insights.hashes-equal",
            insights.Count(i => !storedInsights.TryGetValue(i.Id, out var s) || CanonicalPayload.Sha256(s) != CanonicalPayload.Sha256(i))
            + planned.Count(q => !storedQuestions.TryGetValue(q.Id, out var s) || CanonicalPayload.Sha256(s) != CanonicalPayload.Sha256(q))));
    }, ct);

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
    internal sealed record Insight
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
    internal sealed record Question
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
