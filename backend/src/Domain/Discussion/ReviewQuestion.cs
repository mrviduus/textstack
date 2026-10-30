namespace Domain.Discussion;

/// <summary>
/// One self-check question of a chapter review, with its own review schedule (V2 table
/// <c>review_question</c>; ADR-016 §4). Re-saving the review keeps the schedule of a question whose
/// <see cref="PromptHash"/> is unchanged. The SRS fields mean what they mean on a vocabulary card;
/// the math is <c>SrsEngine</c>'s, not the repository's.
/// </summary>
public class ReviewQuestion
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookInsightId { get; set; }

    /// <summary>0-based index of the review block this question belongs to (display order).</summary>
    public int BlockIndex { get; set; }

    public string Prompt { get; set; } = "";
    public string Answer { get; set; } = "";

    /// <summary>First 16 hex of sha256(normalized prompt): the identity that survives a re-save.</summary>
    public string PromptHash { get; set; } = "";

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
}
