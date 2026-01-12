using Api.Sites;
using Application.Common.Interfaces;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class SsgEndpoints
{
    private const string SsgApiKeyHeader = "X-SSG-Key";

    public static void MapSsgEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/ssg").WithTags("SSG");

        group.MapGet("/books", GetBooks).WithName("SsgGetBooks");
        group.MapGet("/chapters/{bookSlug}", GetChapters).WithName("SsgGetChapters");
        group.MapGet("/authors", GetAuthors).WithName("SsgGetAuthors");
        group.MapGet("/genres", GetGenres).WithName("SsgGetGenres");
    }

    private static bool ValidateApiKey(HttpContext ctx, IConfiguration config)
    {
        var expectedKey = config["SSG_API_KEY"];
        if (string.IsNullOrEmpty(expectedKey))
            return true; // No key configured = no protection (dev mode)

        var providedKey = ctx.Request.Headers[SsgApiKeyHeader].FirstOrDefault();
        return providedKey == expectedKey;
    }

    /// <summary>
    /// GET /ssg/books — all published editions (slug + language only)
    /// </summary>
    private static async Task<IResult> GetBooks(
        HttpContext httpContext,
        IAppDbContext db,
        IConfiguration config,
        CancellationToken ct)
    {
        if (!ValidateApiKey(httpContext, config))
            return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        var books = await db.Editions
            .Where(e => e.SiteId == siteId && e.Status == EditionStatus.Published && e.Indexable)
            .OrderBy(e => e.Slug)
            .Select(e => new SsgBookDto(e.Slug, e.Language))
            .ToListAsync(ct);

        return Results.Ok(books);
    }

    /// <summary>
    /// GET /ssg/chapters/{bookSlug} — all chapter slugs for a book
    /// </summary>
    private static async Task<IResult> GetChapters(
        string bookSlug,
        HttpContext httpContext,
        IAppDbContext db,
        IConfiguration config,
        CancellationToken ct)
    {
        if (!ValidateApiKey(httpContext, config))
            return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        var chapters = await db.Chapters
            .Where(c => c.Edition.SiteId == siteId
                && c.Edition.Slug == bookSlug
                && c.Edition.Status == EditionStatus.Published
                && c.Slug != null)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => new SsgChapterDto(c.Slug!, c.ChapterNumber))
            .ToListAsync(ct);

        if (chapters.Count == 0)
            return Results.NotFound();

        return Results.Ok(chapters);
    }

    /// <summary>
    /// GET /ssg/authors — all indexable author slugs
    /// </summary>
    private static async Task<IResult> GetAuthors(
        HttpContext httpContext,
        IAppDbContext db,
        IConfiguration config,
        CancellationToken ct)
    {
        if (!ValidateApiKey(httpContext, config))
            return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        var authors = await db.Authors
            .Where(a => a.SiteId == siteId && a.Indexable)
            .OrderBy(a => a.Slug)
            .Select(a => new SsgAuthorDto(a.Slug))
            .ToListAsync(ct);

        return Results.Ok(authors);
    }

    /// <summary>
    /// GET /ssg/genres — all indexable genre slugs
    /// </summary>
    private static async Task<IResult> GetGenres(
        HttpContext httpContext,
        IAppDbContext db,
        IConfiguration config,
        CancellationToken ct)
    {
        if (!ValidateApiKey(httpContext, config))
            return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        var genres = await db.Genres
            .Where(g => g.SiteId == siteId && g.Indexable)
            .OrderBy(g => g.Slug)
            .Select(g => new SsgGenreDto(g.Slug))
            .ToListAsync(ct);

        return Results.Ok(genres);
    }
}

// Minimal DTOs for SSG
public record SsgBookDto(string Slug, string Language);
public record SsgChapterDto(string Slug, int Order);
public record SsgAuthorDto(string Slug);
public record SsgGenreDto(string Slug);
