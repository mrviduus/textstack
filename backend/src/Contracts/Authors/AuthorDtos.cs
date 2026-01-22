namespace Contracts.Authors;

public record AuthorListDto(
    Guid Id,
    string Slug,
    string Name,
    string? PhotoPath,
    int BookCount
);

public record AuthorDetailDto(
    Guid Id,
    string Slug,
    string Name,
    string? Bio,
    string? PhotoPath,
    string? SeoTitle,
    string? SeoDescription,
    List<AuthorEditionDto> Editions
);

public record AuthorEditionDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? CoverPath
);
