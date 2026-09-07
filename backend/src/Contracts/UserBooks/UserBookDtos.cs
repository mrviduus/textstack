namespace Contracts.UserBooks;

public record UserBookListDto(
    Guid Id,
    string Title,
    string Slug,
    string Language,
    string? Author,
    string? Description,
    string? CoverPath,
    string? Genre,
    string Status,
    string? ErrorMessage,
    int ChapterCount,
    int? TotalWordCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    double? ProgressPercent,
    DateTimeOffset? ProgressUpdatedAt,
    string? ProgressChapterSlug,
    string[] Tags,
    string[] SuggestedTags,
    string? SourceUrl,
    bool IsClip,
    bool IsRead,
    DateTimeOffset? ReadAt,
    // True when the book has a stored PDF original → the library card can open
    // "Original layout" instantly, before extraction finishes.
    bool HasOriginalPdf
);

public record AcceptSuggestedTagsRequest(string[] Accepted);

public record UserBookDetailDto(
    Guid Id,
    string Title,
    string Slug,
    string Language,
    string? Author,
    string? Description,
    string? CoverPath,
    string? Genre,
    int? PublishedYear,
    int? TotalWordCount,
    string Status,
    string? ErrorMessage,
    IReadOnlyList<UserChapterSummaryDto> Chapters,
    IReadOnlyList<TocEntryDto>? Toc,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? CompletedAt,
    // Phase 2 on-demand RAG index state (mirrors the catalog BookDetailDto).
    string RagStatus,
    int RagChunkCount,
    int RagEmbeddedCount,
    // True when the book has a stored PDF original → enables the reader's "Original layout" view.
    bool HasOriginalPdf,
    // Visible enrichment lifecycle: NotStarted|Pending|Running|Completed|Failed (detail-only).
    string MetadataEnrichmentStatus
);

public record UserChapterSummaryDto(
    Guid Id,
    int ChapterNumber,
    string? Slug,
    string Title,
    int? WordCount,
    // 1-based physical PDF page where this chapter begins (null when unknown / non-PDF).
    int? SourceStartPage
);

public record UserChapterDto(
    Guid Id,
    int ChapterNumber,
    string? Slug,
    string Title,
    string Html,
    int? WordCount,
    UserChapterNavDto? Previous,
    UserChapterNavDto? Next
);

public record UserChapterNavDto(int ChapterNumber, string? Slug, string Title);

public record TocEntryDto(string Title, int? ChapterNumber, IReadOnlyList<TocEntryDto>? Children);

// HasOriginalPdf lets the upload redirect open a PDF into "Original layout"
// immediately — the file is stored at upload, so it is true the instant a PDF lands.
public record UploadUserBookResponse(Guid UserBookId, Guid JobId, string Status, bool HasOriginalPdf);

/// <summary>
/// "Send to TextStack" web clip — the extension sends already-clean (Readability) article HTML.
/// The server never fetches a URL. Lands on the private Read later shelf.
/// </summary>
public record ClipRequest(string Title, string? Author, string? SourceUrl, string Html, string? Language);

/// <param name="Tier">Entitlement tier name (Guest|Free|Supporter|Staff).</param>
/// <param name="MaxBooks">Book-count cap, or null for unlimited.</param>
/// <param name="MaxSingleUploadBytes">
/// Largest body a single request may carry — a PLATFORM limit (Cloudflare), not a tier perk.
/// Clients use it to decide when to switch to the chunked upload path, and to explain the refusal
/// honestly instead of surfacing a raw 413.
/// </param>
public record StorageQuotaDto(
    long UsedBytes,
    long LimitBytes,
    double UsedPercent,
    string Tier,
    int? MaxBooks,
    int BooksUsed,
    long MaxSingleUploadBytes);

public record UserBookProgressDto(
    string? ChapterSlug,
    string? Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt,
    /// <summary>The logical position, when the row holds one. Same contract as
    /// ReadingProgressDto.PositionJson — see Domain.Entities.ReadingProgress.PositionJson.</summary>
    string? PositionJson = null
);

// ChapterSlug is nullable: PDFs opened in "Original layout" (ADR-012) have no
// chapter — their position is a PAGE carried in Locator ("page:N"). Reflow/EPUB
// callers still send a chapter slug (backward compatible).
public record UpsertUserBookProgressRequest(
    string? ChapterSlug,
    string? Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt,
    /// <summary>What Percent is a fraction OF. Only "book" is stored; a percentage
    /// without a declared unit is left unsaved. See Application.ReadingTracking.ProgressUnit.</summary>
    string? PercentUnit = null,
    /// <summary>The coordinate space Locator is written in — "page" or "scroll".
    /// Required only to move a book BETWEEN spaces; a write that stays in the space
    /// already stored is accepted without it, so older clients keep working.
    /// See Application.ReadingTracking.LocatorSpace.</summary>
    string? LocatorKind = null,
    /// <summary>The logical position this write is really about. Absent means absent,
    /// not unchanged. See Application.ReadingTracking.ReaderPosition.</summary>
    string? PositionJson = null
);

// ChapterId/ChapterSlug are nullable: PDFs opened in "Original layout" (ADR-012) are
// chapterless — a page bookmark anchors on Locator ("page:N") with no chapter. Reflow/EPUB
// bookmarks still carry a chapter (backward compatible).
public record UserBookBookmarkDto(
    Guid Id,
    Guid? ChapterId,
    string? ChapterSlug,
    string Locator,
    string? Title,
    DateTimeOffset CreatedAt
);

public record CreateUserBookBookmarkRequest(
    Guid? ChapterId,
    string Locator,
    string? Title
);

public record UpdateUserBookMetadataRequest(
    string Title,
    string? Author,
    string Language,
    string? Genre,
    string? Description,
    int? PublishedYear
);

public record SetTagsRequest(string[] Tags);

public record TagCountDto(string Tag, int Count);

public record BulkIdsRequest(Guid[] Ids);

public record BulkFinishRequest(Guid[] Ids, bool IsFinished);

public record BulkTagsRequest(Guid[] Ids, string[]? AddTags, string[]? RemoveTags);

public record BulkCollectionRequest(Guid[] Ids, string BookType);

public record BulkResultDto(Guid[] Succeeded, BulkFailureDto[] Failed);

public record BulkFailureDto(Guid Id, string Reason);

public record UserBookSearchHitDto(
    Guid Id,
    string Title,
    string? Author,
    string? CoverPath,
    string Language,
    double Rank,
    string? Excerpt,
    string? ChapterSlug
);

public record BookStatsDto(
    Guid BookId,
    int SessionsCount,
    long TotalReadMinutes,
    int WordsRead,
    int VocabSavedCount,
    int HighlightsCount,
    decimal AverageWordsPerMinute,
    int? EstimatedMinutesRemaining
);
