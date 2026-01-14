namespace Contracts.Admin;

public record AdminGenreSearchResultDto(
    Guid Id,
    string Slug,
    string Name,
    int EditionCount
);

public record AdminGenreListDto(
    Guid Id,
    string Slug,
    string Name,
    string? Description,
    bool Indexable,
    int EditionCount,
    bool HasPublishedBooks,
    DateTimeOffset UpdatedAt
);

public record AdminGenreDetailDto(
    Guid Id,
    Guid SiteId,
    string Slug,
    string Name,
    string? Description,
    bool Indexable,
    string? SeoTitle,
    string? SeoDescription,
    int EditionCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    List<AdminGenreEditionDto> Editions
);

public record AdminGenreEditionDto(
    Guid EditionId,
    string Slug,
    string Title,
    string Status
);

public record CreateGenreRequest(
    Guid SiteId,
    string Name
);

public record CreateGenreResponse(
    Guid Id,
    string Slug,
    string Name,
    bool IsNew
);

public record UpdateGenreRequest(
    string Name,
    string? Description,
    bool? Indexable,
    string? SeoTitle,
    string? SeoDescription
);
