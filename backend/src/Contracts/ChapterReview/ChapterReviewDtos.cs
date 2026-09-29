using System.Text.Json;

namespace Contracts.ChapterReview;

// Chapter review — the reader's own assistant reviews one chapter over MCP and the result comes home
// as structure. Spec: docs/05-features/chapter-review.md; storage: ADR-016.

// ── stored review (book_insight.review_json; also GET /me/insights → Review) ──────────────────────

/// <summary>
/// A saved chapter review. <paramref name="MethodVersion"/> and thread ids are server-owned: the
/// method version is stamped at save, thread ids are derived from chapter slug + text.
/// </summary>
public sealed record ChapterReviewDto(
    int MethodVersion,
    string? Recall,
    IReadOnlyList<ReviewBlockDto> Blocks,
    IReadOnlyList<string> Applications,
    IReadOnlyList<ReviewThreadDto> OpenThreads,
    IReadOnlyList<string> ClosedThreadIds);

public sealed record ReviewBlockDto(
    string Title,
    string Problem,
    string RootCause,
    string Rule,
    IReadOnlyList<Guid> HighlightIds,
    ReviewQuestionDto Question);

public sealed record ReviewQuestionDto(string Prompt, string Answer);

public sealed record ReviewThreadDto(string Id, string Text);

// ── input (PUT /me/chapter-review) ────────────────────────────────────────────────────────────────

/// <summary>
/// <paramref name="Review"/> stays raw: the service deserializes it itself with unmapped members
/// disallowed, so an unknown property becomes a located validation error instead of a silent drop.
/// </summary>
public sealed record SaveChapterReviewRequest(
    Guid? UserBookId,
    Guid? EditionId,
    string? ChapterSlug,
    JsonElement Review);

/// <summary>
/// The model's review as sent. Everything nullable so a missing field is a validation error with a
/// path, not a deserialization failure; highlight ids are strings for the same reason.
/// </summary>
public sealed record ChapterReviewInput(
    string? Recall,
    IReadOnlyList<ReviewBlockInput?>? Blocks,
    IReadOnlyList<string?>? Applications,
    IReadOnlyList<ReviewThreadInput?>? OpenThreads,
    IReadOnlyList<string?>? ClosedThreadIds);

public sealed record ReviewBlockInput(
    string? Title,
    string? Problem,
    string? RootCause,
    string? Rule,
    IReadOnlyList<string?>? HighlightIds,
    ReviewQuestionInput? Question);

public sealed record ReviewQuestionInput(string? Prompt, string? Answer);

public sealed record ReviewThreadInput(string? Text);

// ── context (GET /me/chapter-review) ──────────────────────────────────────────────────────────────

/// <summary>
/// Everything a review needs, in one call. Part ≥ 2 carries only <see cref="Book"/> and
/// <see cref="Chapter"/>; every other member is then null.
/// </summary>
public sealed record ChapterReviewContextDto(
    ReviewBookDto Book,
    ReviewChapterDto Chapter,
    string? Method = null,
    int? MethodVersion = null,
    IReadOnlyList<ReviewHighlightDto>? Highlights = null,
    IReadOnlyList<ReviewWordDto>? Words = null,
    IReadOnlyList<OpenThreadDto>? OpenThreads = null,
    ChapterReviewDto? ExistingReview = null,
    bool? RecallRequired = null,
    string? SaveWith = null);

/// <param name="Kind"><c>"userbook"</c> or <c>"catalog"</c>.</param>
public sealed record ReviewBookDto(string Kind, Guid? BookId, Guid? EditionId, string Title, string? Author);

public sealed record ReviewChapterDto(string Slug, string Title, int Part, int PartCount, string Text);

public sealed record ReviewHighlightDto(Guid Id, string Text, string? Note);

public sealed record ReviewWordDto(string Word, string? Translation, string? Definition, string? Sentence);

public sealed record OpenThreadDto(string Id, string Text, string? OpenedInChapter);

// ── save result + errors ──────────────────────────────────────────────────────────────────────────

public sealed record ChapterReviewSavedDto(
    bool Saved,
    Guid InsightId,
    string ChapterSlug,
    int QuestionCount,
    IReadOnlyList<ReviewThreadDto> OpenThreads,
    IReadOnlyList<string> ClosedThreadIds,
    DateTimeOffset UpdatedAt);

/// <summary>
/// Every non-2xx from the review routes. <paramref name="Error"/> ∈ bad_request, review_invalid,
/// not_found, chapter_not_reached, review_exists. The MCP bridge relays message + errors verbatim.
/// </summary>
public sealed record ReviewErrorDto(
    string Error,
    string Message,
    IReadOnlyList<ReviewFieldErrorDto>? Errors = null,
    string? CurrentChapterSlug = null,
    string? CurrentChapterTitle = null);

public sealed record ReviewFieldErrorDto(string Path, string Code, string Message);

// ── review-question queue ─────────────────────────────────────────────────────────────────────────

public sealed record DueReviewQuestionsDto(int TotalDue, IReadOnlyList<DueReviewQuestionDto> Items);

public sealed record DueReviewQuestionDto(
    Guid Id,
    string Prompt,
    string Answer,
    string? BlockTitle,
    string? Rule,
    string BookTitle,
    string? ChapterTitle,
    string? ChapterSlug,
    Guid? UserBookId,
    Guid? EditionId);

/// <param name="SelfAssessment"><c>"forgot"</c> | <c>"almost"</c> | <c>"knew"</c>.</param>
public sealed record AnswerReviewQuestionRequest(string? SelfAssessment);

public sealed record AnswerReviewQuestionResponse(int Stage, DateTimeOffset NextReviewAt, bool Retired);
