using Application.Common.Interfaces;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.SsgRebuild;

/// <summary>
/// Queries database for routes to prerender.
/// </summary>
public class SsgRouteProvider : ISsgRouteProvider
{
    private readonly IAppDbContext _db;

    public SsgRouteProvider(IAppDbContext db)
    {
        _db = db;
    }

    public async Task<List<SsgRoute>> GetRoutesAsync(
        Guid siteId,
        SsgRebuildMode mode,
        string[]? bookSlugs,
        string[]? authorSlugs,
        string[]? genreSlugs,
        CancellationToken ct)
    {
        var site = await _db.Sites.FirstOrDefaultAsync(s => s.Id == siteId, ct);
        if (site == null)
            return [];

        var routes = new List<SsgRoute>();

        // Static routes (only for Full/Incremental)
        if (mode == SsgRebuildMode.Full || mode == SsgRebuildMode.Incremental)
        {
            AddStaticRoutes(routes, site.DefaultLanguage);
        }

        // Content routes
        await AddBookRoutesAsync(routes, siteId, mode, bookSlugs, ct);
        await AddAuthorRoutesAsync(routes, siteId, site.DefaultLanguage, mode, authorSlugs, ct);
        await AddGenreRoutesAsync(routes, siteId, site.DefaultLanguage, mode, genreSlugs, ct);

        return routes;
    }

    private static void AddStaticRoutes(List<SsgRoute> routes, string lang)
    {
        routes.Add(new SsgRoute($"/{lang}", "static"));
        routes.Add(new SsgRoute($"/{lang}/books", "static"));
        routes.Add(new SsgRoute($"/{lang}/authors", "static"));
        routes.Add(new SsgRoute($"/{lang}/genres", "static"));
    }

    private async Task AddBookRoutesAsync(
        List<SsgRoute> routes,
        Guid siteId,
        SsgRebuildMode mode,
        string[]? slugs,
        CancellationToken ct)
    {
        var query = _db.Editions
            .Where(e => e.SiteId == siteId && e.Status == EditionStatus.Published && e.Indexable);

        if (mode == SsgRebuildMode.Specific && slugs?.Length > 0)
            query = query.Where(e => slugs.Contains(e.Slug));

        var books = await query
            .Select(e => new { e.Slug, e.Language })
            .ToListAsync(ct);

        routes.AddRange(books.Select(b => new SsgRoute($"/{b.Language}/books/{b.Slug}", "book")));
    }

    private async Task AddAuthorRoutesAsync(
        List<SsgRoute> routes,
        Guid siteId,
        string lang,
        SsgRebuildMode mode,
        string[]? slugs,
        CancellationToken ct)
    {
        var query = _db.Authors
            .Where(a => a.SiteId == siteId && a.Indexable)
            .Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Status == EditionStatus.Published &&
                ea.Edition.Indexable));

        if (mode == SsgRebuildMode.Specific && slugs?.Length > 0)
            query = query.Where(a => slugs.Contains(a.Slug));

        var authors = await query.Select(a => a.Slug).ToListAsync(ct);
        routes.AddRange(authors.Select(a => new SsgRoute($"/{lang}/authors/{a}", "author")));
    }

    private async Task AddGenreRoutesAsync(
        List<SsgRoute> routes,
        Guid siteId,
        string lang,
        SsgRebuildMode mode,
        string[]? slugs,
        CancellationToken ct)
    {
        var query = _db.Genres
            .Where(g => g.SiteId == siteId && g.Indexable)
            .Where(g => g.Editions.Any(e =>
                e.Status == EditionStatus.Published &&
                e.Indexable));

        if (mode == SsgRebuildMode.Specific && slugs?.Length > 0)
            query = query.Where(g => slugs.Contains(g.Slug));

        var genres = await query.Select(g => g.Slug).ToListAsync(ct);
        routes.AddRange(genres.Select(g => new SsgRoute($"/{lang}/genres/{g}", "genre")));
    }
}
