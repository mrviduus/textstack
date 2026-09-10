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
    bool Indexable,
    string? SeoTitle,
    string? SeoDescription,
    // SEO content blocks
    string? SeoRelevanceText,
    string? SeoThemesJson,
    string? SeoFaqsJson,
    WorkDto Work,
    IReadOnlyList<ChapterSummaryDto> Chapters,
    IReadOnlyList<EditionSummaryDto> OtherEditions,
    IReadOnlyList<BookAuthorDto> Authors,
    IReadOnlyList<BookGenreDto> Genres,
    IReadOnlyList<RelatedBookDto> MoreByAuthor,
    IReadOnlyList<TocEntryDto>? Toc = null
);

public record BookGenreDto(Guid Id, string Slug, string Name);

public record RelatedBookDto(Guid Id, string Slug, string Title, string? CoverPath);

public record WorkDto(Guid Id, string Slug);

public record ChapterSummaryDto(
    Guid Id,
    int ChapterNumber,
    string? Slug,
    string Title,
    int? WordCount
);

public record EditionSummaryDto(Guid Id, string Slug, string Language, string Title);

public record TocEntryDto(
    string Title,
    int ChapterNumber,
    string? Anchor,
    int Level,
    IReadOnlyList<TocEntryDto>? Children
);
