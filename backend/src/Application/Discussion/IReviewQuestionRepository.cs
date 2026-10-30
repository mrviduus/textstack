using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The V2 review questions (table <c>review_question</c>; ADR-016 §4): the self-check questions of a
/// chapter review, each with its SRS schedule. The repository only stores a schedule; computing one
/// is <c>SrsEngine</c>'s job. Every method is scoped to <c>userId</c>
/// (docs/01-architecture/data-access.md rule 7).
/// </summary>
public interface IReviewQuestionRepository
{
    /// <summary>
    /// The user's questions due at <paramref name="now"/>, not retired, most overdue first: up to
    /// <paramref name="limit"/> of them, and how many are due in all.
    /// </summary>
    Task<DueReviewQuestions> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct);

    /// <summary>One of the user's questions; null when not the user's.</summary>
    Task<ReviewQuestion?> GetAsync(Guid userId, Guid id, CancellationToken ct);

    /// <summary>
    /// Makes <paramref name="questions"/> the insight's question set, in one transaction, matched by
    /// <c>PromptHash</c>: a new hash is inserted with the initial schedule it carries (stage, interval,
    /// consecutive correct, next review; no answers yet); a known hash gets the new prompt, answer and
    /// block index and keeps its schedule and counts; a hash no longer present is deleted. Each
    /// question's own <c>UserId</c>/<c>BookInsightId</c> are ignored. False, and nothing written, when
    /// the insight is not the user's.
    /// </summary>
    Task<bool> ReplaceForInsightAsync(
        Guid userId, Guid insightId, IReadOnlyList<ReviewQuestion> questions, CancellationToken ct);

    /// <summary>Stores the schedule an answer produced; returns the question, or null when not the user's.</summary>
    Task<ReviewQuestion?> RecordAnswerAsync(Guid userId, Guid id, ReviewSchedule schedule, CancellationToken ct);
}

/// <summary>A page of due questions, and the number due in all.</summary>
public sealed record DueReviewQuestions(int Total, IReadOnlyList<ReviewQuestion> Questions);

/// <summary>A question's SRS state after an answer, as <c>SrsEngine</c> computed it.</summary>
public sealed record ReviewSchedule(
    int Stage,
    double IntervalDays,
    int ConsecutiveCorrect,
    DateTimeOffset NextReviewAt,
    DateTimeOffset LastReviewedAt,
    int TotalReviews,
    int CorrectReviews,
    bool IsRetired);
