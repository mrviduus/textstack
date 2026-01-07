namespace Contracts.Admin;

public record AdminStatsDto(
    int TotalEditions,
    int PublishedEditions,
    int DraftEditions,
    int TotalChapters,
    int TotalAuthors
);
