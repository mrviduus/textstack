namespace Contracts.Books;

public record BookDetailDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? Description,
    string? CoverPath,
    DateTimeOffset? PublishedAt,
    bool IsPublicDomain,
    string? SeoTitle,
    string? SeoDescription,
    WorkDto Work,
    IReadOnlyList<ChapterSummaryDto> Chapters,
    IReadOnlyList<EditionSummaryDto> OtherEditions,
    IReadOnlyList<BookAuthorDto> Authors
);

public record WorkDto(Guid Id, string Slug);

public record ChapterSummaryDto(
    Guid Id,
    int ChapterNumber,
    string? Slug,
    string Title,
    int? WordCount
);

public record EditionSummaryDto(Guid Id, string Slug, string Language, string Title);
