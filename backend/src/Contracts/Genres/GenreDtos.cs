namespace Contracts.Genres;

public record GenreListDto(
    Guid Id,
    string Slug,
    string Name,
    int BookCount
);

public record GenreDetailDto(
    Guid Id,
    string Slug,
    string Name,
    string? Description,
    string? SeoTitle,
    string? SeoDescription,
    int BookCount,
    List<GenreEditionDto> Editions
);

public record GenreEditionDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? CoverPath
);
