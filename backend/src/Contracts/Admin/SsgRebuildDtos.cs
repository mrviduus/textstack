namespace Contracts.Admin;

// --- Requests ---

public record CreateSsgRebuildJobRequest(
    Guid SiteId,
    string Mode = "Full",
    int? Concurrency = null,
    string[]? BookSlugs = null,
    string[]? AuthorSlugs = null,
    string[]? GenreSlugs = null
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
    string[]? BookSlugs,
    string[]? AuthorSlugs,
    string[]? GenreSlugs,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt
);

public record SsgRebuildJobStatsDto(
    int Total,
    int Successful,
    int Failed,
    int BookRoutes,
    int AuthorRoutes,
    int GenreRoutes,
    int StaticRoutes,
    double AvgRenderTimeMs
);

// --- Result DTOs ---

public record SsgRebuildResultDto(
    Guid Id,
    string Route,
    string RouteType,
    bool Success,
    int? RenderTimeMs,
    string? Error,
    DateTimeOffset RenderedAt
);

public record SsgRebuildResultsFilter(
    bool? Failed = null,
    string? RouteType = null,
    int Offset = 0,
    int Limit = 50
);

// --- Preview DTO ---

public record SsgRebuildPreviewDto(
    int TotalRoutes,
    int BookCount,
    int AuthorCount,
    int GenreCount,
    int StaticCount
);
