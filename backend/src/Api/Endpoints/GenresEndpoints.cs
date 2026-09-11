using Api.Sites;
using Application.Common.Interfaces;
using Contracts.Genres;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class GenresEndpoints
{
    public static void MapGenresEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/genres").WithTags("Genres");

        group.MapGet("", GetGenres).WithName("GetGenres");
        group.MapGet("/{slug}", GetGenre).WithName("GetGenre");
    }

    private static async Task<IResult> GetGenres(
        HttpContext httpContext,
        IAppDbContext db,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? language,
        CancellationToken ct)
    {
        var take = Math.Min(limit ?? 50, 100);
        var skip = offset ?? 0;

        var query = db.Genres
            .Where(g => g.Indexable)
            .AsQueryable();

        // Filter to genres with published editions (optionally in a specific language)
        query = !string.IsNullOrEmpty(language)
            ? query.Where(g => g.Editions.Any(e => e.Status == Domain.Enums.EditionStatus.Published && e.Language == language))
            : query.Where(g => g.Editions.Any(e => e.Status == Domain.Enums.EditionStatus.Published));

        var ordered = query.OrderBy(g => g.Name);

        var total = await ordered.CountAsync(ct);
        var items = await ordered
            .Skip(skip)
            .Take(take)
            .Select(g => new GenreListDto(
                g.Id,
                g.Slug,
                g.Name,
                !string.IsNullOrEmpty(language)
                    ? g.Editions.Count(e => e.Status == Domain.Enums.EditionStatus.Published && e.Language == language)
                    : g.Editions.Count(e => e.Status == Domain.Enums.EditionStatus.Published)
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetGenre(
        HttpContext httpContext,
        IAppDbContext db,
        string slug,
        CancellationToken ct)
    {

        var genre = await db.Genres
            .Where(g => g.Slug == slug)
            .Select(g => new GenreDetailDto(
                g.Id,
                g.Slug,
                g.Name,
                g.Description,
                g.SeoTitle,
                g.SeoDescription,
                g.Editions.Count(e => e.Status == Domain.Enums.EditionStatus.Published),
                g.Editions
                    .Where(e => e.Status == Domain.Enums.EditionStatus.Published)
                    .Select(e => new GenreEditionDto(
                        e.Id,
                        e.Slug,
                        e.Title,
                        e.Language,
                        e.CoverPath,
                        // Same projection the book list uses (BookService), ordered the same way, so a
                        // book's authors read identically wherever it appears.
                        e.EditionAuthors
                            .OrderBy(ea => ea.Order)
                            .Select(ea => new Contracts.Books.BookAuthorDto(
                                ea.Author.Id,
                                ea.Author.Slug,
                                ea.Author.Name,
                                ea.Role.ToString()
                            ))
                            .ToList()
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);

        // Return 404 if genre doesn't exist OR has no published editions
        if (genre is null || genre.Editions.Count == 0)
            return Results.NotFound();

        return Results.Ok(genre);
    }
}
