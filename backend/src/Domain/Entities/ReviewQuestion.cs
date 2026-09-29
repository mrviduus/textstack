namespace Domain.Entities;

/// <summary>
/// One self-check question from a chapter review, with its own spaced-repetition state.
///
/// <para>The review itself lives in the chapter's <see cref="BookInsight"/> (<c>ReviewJson</c>) and is
/// replaced as a whole on every save; scheduling state is per question and changes on every answer,
/// so it gets this table (ADR-016 §4). Re-saving a review keeps the state of a question whose prompt
/// did not change — matched by <see cref="PromptHash"/> — and deletes the ones that went away.</para>
///
/// <para>SRS fields mean exactly what they mean on <see cref="VocabularyWord"/>; the math is the same
/// <c>SrsEngine</c>. Plain POCO; EF mapping in AppDbContext.Insights.cs.</para>
/// </summary>
public class ReviewQuestion : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid BookInsightId { get; set; }

    /// <summary>0-based index of the review block this question belongs to (display order).</summary>
    public int BlockIndex { get; set; }

    public string Prompt { get; set; } = "";
    public string Answer { get; set; } = "";

    /// <summary>First 16 hex of sha256(normalized prompt) — the identity that survives a re-save.</summary>
    public string PromptHash { get; set; } = "";

    // SRS
    public int Stage { get; set; }
    public double IntervalDays { get; set; }
    public int ConsecutiveCorrect { get; set; }
    public DateTimeOffset NextReviewAt { get; set; }
    public DateTimeOffset? LastReviewedAt { get; set; }
    public int TotalReviews { get; set; }
    public int CorrectReviews { get; set; }
    public bool IsRetired { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public BookInsight BookInsight { get; set; } = null!;
}
