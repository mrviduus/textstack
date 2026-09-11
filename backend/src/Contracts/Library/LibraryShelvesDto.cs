namespace Contracts.Library;

public record LibraryShelvesDto(
    IReadOnlyList<LibraryShelfItemDto> ContinueReading,
    IReadOnlyList<LibraryShelfItemDto> RecentlyAdded,
    IReadOnlyList<LibraryShelfItemDto> QuickReads,
    IReadOnlyList<LibraryShelfItemDto> FinishedThisMonth
);

public record LibraryShelfItemDto(
    Guid Id,
    string Type,
    string Title,
    string? Author,
    string? CoverPath,
    string? Slug,
    string? Language,
    double ProgressPercent,
    DateTimeOffset? LastOpenedAt,
    DateTimeOffset CreatedAt,
    int? EstimatedMinutesRemaining,
    /// <summary>
    /// Where the reader stopped, so a shelf card can offer to continue rather
    /// than only to open.
    /// <para>
    /// These queries have always SELECTED the locator and then thrown it away,
    /// because the DTO had nowhere to put it — so "Continue Reading" was a shelf
    /// that could not continue anything, and every client had to make a second
    /// request per book to find out where. <see cref="PositionJson"/> is the
    /// logical position (ADR-015) and is preferred; the locator is what a row
    /// written by an older build has to offer.
    /// </para>
    /// </summary>
    string? CurrentLocator = null,
    string? PositionJson = null,
    /// <summary>
    /// The chapter the reader stopped in, by slug.
    /// <para>
    /// Both queries have always SELECTED this — the upload one directly, the catalog one as a chapter
    /// id — and then dropped it, for the same reason the locator was dropped: the DTO had nowhere to
    /// put it. That is why <c>continueReading.ts</c> exists: its own doc comment says the shelves
    /// payload "carries no chapterSlug, so a shelf tap structurally cannot resume at the right
    /// chapter", and every client has been making a second request per book to find out.
    /// </para>
    /// <para>
    /// Null for a chapterless PDF read in Original layout (ADR-012), whose position is a page in
    /// <see cref="CurrentLocator"/> rather than a chapter.
    /// </para>
    /// </summary>
    string? ChapterSlug = null
);
