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

/// <summary>
/// One book on a genre page.
///
/// <para><see cref="Authors"/> was missing until 2026-09-11, and both clients had already been
/// written as if it were there: the mobile genre screen called <c>ed.authors.map(...)</c> and threw
/// <c>Cannot read property 'map' of undefined</c> on every genre that has books, while the web page
/// wrote <c>ed.authors || []</c> and so rendered its "Popular authors in …" section empty forever.
/// Neither was caught by the compiler, because the shared TypeScript type declared these editions as
/// the full <c>Edition</c> shape — a type that described something the endpoint never sent.</para>
/// </summary>
public record GenreEditionDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? CoverPath,
    IReadOnlyList<Contracts.Books.BookAuthorDto> Authors
);
