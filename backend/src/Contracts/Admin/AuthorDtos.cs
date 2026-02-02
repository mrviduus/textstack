namespace Contracts.Admin;

public record AdminAuthorSearchResultDto(
    Guid Id,
    string Slug,
    string Name,
    int BookCount
);

public record AdminAuthorListDto(
    Guid Id,
    string Slug,
    string Name,
    string? PhotoPath,
    int BookCount,
    bool HasPublishedBooks,
    DateTimeOffset CreatedAt
);

public record AdminAuthorDetailDto(
    Guid Id,
    Guid SiteId,
    string Slug,
    string Name,
    string? Bio,
    string? PhotoPath,
    bool Indexable,
    string? SeoTitle,
    string? SeoDescription,
    string? CanonicalOverride,
    string? SeoRelevanceText,
    string? SeoThemesJson,
    string? SeoFaqsJson,
    int BookCount,
    DateTimeOffset CreatedAt,
    List<AdminAuthorBookDto> Books
);

public record AdminAuthorBookDto(
    Guid EditionId,
    string Slug,
    string Title,
    string Role,
    string Status
);

public record CreateAuthorRequest(
    Guid SiteId,
    string Name
);

public record CreateAuthorResponse(
    Guid Id,
    string Slug,
    string Name,
    bool IsNew
);

public record UpdateAuthorRequest(
    string Name,
    string? Bio,
    bool? Indexable,
    string? SeoTitle,
    string? SeoDescription,
    string? CanonicalOverride,
    string? SeoRelevanceText,
    string? SeoThemesJson,
    string? SeoFaqsJson
);

public record AdminAuthorStatsDto(
    int Total,
    int WithPublishedBooks,
    int WithoutPublishedBooks,
    int TotalBooks
);
