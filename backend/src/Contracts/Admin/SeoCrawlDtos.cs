namespace Contracts.Admin;

// --- Requests ---

public record CreateSeoCrawlJobRequest(
    Guid SiteId,
    int? MaxPages = null,
    int? CrawlDelayMs = null,
    int? Concurrency = null
);

// --- Job DTOs ---

public record SeoCrawlJobListDto(
    Guid Id,
    Guid SiteId,
    string SiteCode,
    string Status,
    int TotalUrls,
    int MaxPages,
    int PagesCrawled,
    int ErrorsCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt
);

public record SeoCrawlJobDetailDto(
    Guid Id,
    Guid SiteId,
    string SiteCode,
    int MaxPages,
    int CrawlDelayMs,
    int Concurrency,
    string UserAgent,
    string Status,
    int TotalUrls,
    int PagesCrawled,
    int ErrorsCount,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt
);

public record SeoCrawlJobStatsDto(
    int Total,
    int Status2xx,
    int Status3xx,
    int Status4xx,
    int Status5xx,
    int MissingTitle,
    int MissingDescription,
    int MissingH1,
    int NoIndex
);

// --- Result DTOs ---

public record SeoCrawlResultDto(
    Guid Id,
    string Url,
    string UrlType,
    int? StatusCode,
    string? ContentType,
    int? HtmlBytes,
    string? Title,
    string? MetaDescription,
    string? H1,
    string? Canonical,
    string? MetaRobots,
    string? XRobotsTag,
    DateTimeOffset FetchedAt,
    string? FetchError
);

public record SeoCrawlResultsFilter(
    int? StatusCodeMin = null,
    int? StatusCodeMax = null,
    bool? MissingTitle = null,
    bool? MissingDescription = null,
    bool? MissingH1 = null,
    bool? HasError = null,
    int Offset = 0,
    int Limit = 50
);

// --- Preview DTO ---

public record SeoCrawlPreviewDto(
    int TotalUrls,
    int BookCount,
    int AuthorCount,
    int GenreCount
);
