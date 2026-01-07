namespace Contracts.Admin;

public record AdminEditionListDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string Status,
    int ChapterCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? PublishedAt,
    string Authors
);

public record AdminEditionDetailDto(
    Guid Id,
    Guid WorkId,
    Guid SiteId,
    string Slug,
    string Title,
    string Language,
    string? Description,
    string? CoverPath,
    string Status,
    bool IsPublicDomain,
    DateTimeOffset CreatedAt,
    DateTimeOffset? PublishedAt,
    List<AdminChapterDto> Chapters,
    List<AdminEditionAuthorDto> Authors,
    List<AdminEditionGenreDto> Genres,
    // SEO fields
    bool Indexable,
    string? SeoTitle,
    string? SeoDescription,
    string? CanonicalOverride
);

public record AdminEditionAuthorDto(
    Guid Id,
    string Slug,
    string Name,
    int Order,
    string Role
);

public record AdminEditionGenreDto(
    Guid Id,
    string Slug,
    string Name
);

public record AdminChapterDto(
    Guid Id,
    int ChapterNumber,
    string Slug,
    string Title,
    int? WordCount
);

public record UpdateEditionRequest(
    string Title,
    string? Description,
    bool? Indexable,
    string? SeoTitle,
    string? SeoDescription,
    string? CanonicalOverride,
    List<UpdateEditionAuthorDto>? Authors,
    List<Guid>? GenreIds
);

public record UpdateEditionAuthorDto(
    Guid AuthorId,
    string Role
);

// Chapter management
public record AdminChapterDetailDto(
    Guid Id,
    Guid EditionId,
    int ChapterNumber,
    string? Slug,
    string Title,
    string Html,
    int? WordCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public record UpdateChapterRequest(
    string Title,
    string Html
);

public record ReorderChaptersRequest(
    List<Guid> ChapterIds
);
