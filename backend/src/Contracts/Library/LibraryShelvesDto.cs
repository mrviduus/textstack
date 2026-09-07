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
    string? PositionJson = null
);
