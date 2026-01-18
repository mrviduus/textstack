using Api.Sites;
using Application.Common.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class AuthorsEndpoints
{
    public static void MapAuthorsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/authors").WithTags("Authors");

        group.MapGet("", GetAuthors).WithName("GetAuthors");
        group.MapGet("/{slug}", GetAuthor).WithName("GetAuthor");
    }

    private static async Task<IResult> GetAuthors(
        HttpContext httpContext,
        IAppDbContext db,
        [FromQuery] string? language,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? sort,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var take = Math.Min(limit ?? 50, 100);
        var skip = offset ?? 0;

        var query = db.Authors
            .Where(a => a.SiteId == siteId && a.Indexable)
            // Only show authors with at least one published edition
            .Where(a => a.EditionAuthors.Any(ea => ea.Edition.Status == Domain.Enums.EditionStatus.Published));

        // Further filter by language if specified
        if (!string.IsNullOrEmpty(language))
        {
            query = query.Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Language == language &&
                ea.Edition.Status == Domain.Enums.EditionStatus.Published));
        }

        query = sort == "recent"
            ? query.OrderByDescending(a => a.CreatedAt)
            : query.OrderBy(a => a.Name);

        var total = await query.CountAsync(ct);
        var items = await query
            .Skip(skip)
            .Take(take)
            .Select(a => new AuthorListDto(
                a.Id,
                a.Slug,
                a.Name,
                a.PhotoPath,
                string.IsNullOrEmpty(language)
                    ? a.EditionAuthors.Count(ea => ea.Edition.Status == Domain.Enums.EditionStatus.Published)
                    : a.EditionAuthors.Count(ea => ea.Edition.Language == language && ea.Edition.Status == Domain.Enums.EditionStatus.Published)
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetAuthor(
        HttpContext httpContext,
        IAppDbContext db,
        string slug,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();

        var author = await db.Authors
            .Where(a => a.SiteId == siteId && a.Slug == slug)
            .Select(a => new AuthorDetailDto(
                a.Id,
                a.Slug,
                a.Name,
                a.Bio,
                a.PhotoPath,
                a.SeoTitle,
                a.SeoDescription,
                a.EditionAuthors
                    .Where(ea => ea.Edition.Status == Domain.Enums.EditionStatus.Published)
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new AuthorEditionDto(
                        ea.Edition.Id,
                        ea.Edition.Slug,
                        ea.Edition.Title,
                        ea.Edition.Language,
                        ea.Edition.CoverPath
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);

        // Return 404 if author doesn't exist OR has no published editions
        if (author is null || author.Editions.Count == 0)
            return Results.NotFound();

        return Results.Ok(author);
    }
}

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
