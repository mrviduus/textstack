namespace Contracts.Admin;

// --- Requests ---

public record CreateSsgRebuildJobRequest(
    Guid SiteId,
    int? Concurrency = null
);

// --- Job DTOs ---

public record SsgRebuildJobListDto(
    Guid Id,
    Guid SiteId,
    string SiteCode,
    string Mode,
    string Status,
    int TotalRoutes,
    int RenderedCount,
    int FailedCount,
    int Concurrency,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt
);

public record SsgRebuildJobDetailDto(
    Guid Id,
    Guid SiteId,
    string SiteCode,
    string Mode,
    string Status,
    int TotalRoutes,
    int RenderedCount,
    int FailedCount,
    int Concurrency,
    int TimeoutMs,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt
);

// --- Preview DTO ---

public record SsgRebuildPreviewDto(
    int TotalRoutes,
    int BookCount,
    int AuthorCount,
    int GenreCount,
    int StaticCount
);
