namespace Contracts.Insights;

/// <summary>
/// A conclusion written back into a book. See <c>Domain.Entities.BookInsight</c> for why these are
/// a catalog keyed by chapter slug rather than a stored conversation.
/// </summary>
/// <param name="ChapterSlug">The chapter this is about; null = the whole book.</param>
/// <param name="ChapterNumber">
/// Resolved from the slug at read time so the client can lay the insights out in reading order.
/// Null for a book-level insight, and also for a chapter slug that no longer resolves — a
/// re-ingestion that renamed a chapter leaves the insight readable but unplaced, which is the right
/// failure: the text is still worth having.
/// </param>
/// <param name="ChapterTitle">Likewise resolved at read time; null when the slug no longer resolves.</param>
public record BookInsightDto(
    Guid Id,
    Guid? EditionId,
    Guid? UserBookId,
    string? ChapterSlug,
    int? ChapterNumber,
    string? ChapterTitle,
    string Text,
    string? Question,
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <summary>
/// Save (upsert) one insight. Exactly one of <paramref name="EditionId"/> / <paramref name="UserBookId"/>.
/// A save to an existing (user, book, chapter) REPLACES it — that is what keeps a re-run's конспект
/// current instead of duplicated.
/// </summary>
public record SaveInsightRequest(
    Guid? EditionId,
    Guid? UserBookId,
    string? ChapterSlug,
    string Text,
    string? Question = null
);
