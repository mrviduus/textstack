namespace Contracts.Books;

public record BookListDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? Description,
    string? CoverPath,
    DateTimeOffset? PublishedAt,
    int ChapterCount,
    IReadOnlyList<BookAuthorDto> Authors,
    int? FeaturedRank
);

public record BookAuthorDto(
    Guid Id,
    string Slug,
    string Name,
    string Role
);

public record ReplaceFeaturedRequest(List<string>? Slugs);

public record ReplaceFeaturedResult(IReadOnlyList<string> Applied, IReadOnlyList<string> NotFound);
