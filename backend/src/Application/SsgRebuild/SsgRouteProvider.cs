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
        CancellationToken ct)
    {
        var site = await _db.Sites.FirstOrDefaultAsync(s => s.Id == siteId, ct);
        if (site == null)
            return [];

        var routes = new List<SsgRoute>();

        AddStaticRoutes(routes, site.DefaultLanguage);
        await AddBookRoutesAsync(routes, ct);
        await AddAuthorRoutesAsync(routes, site.DefaultLanguage, ct);
        await AddGenreRoutesAsync(routes, site.DefaultLanguage, ct);

        return routes;
    }

    private static void AddStaticRoutes(List<SsgRoute> routes, string lang)
    {
        routes.Add(new SsgRoute($"/{lang}", "static"));
        routes.Add(new SsgRoute($"/{lang}/books", "static"));
        routes.Add(new SsgRoute($"/{lang}/authors", "static"));
        routes.Add(new SsgRoute($"/{lang}/genres", "static"));
        // HTML sitemap — indexable internal-linking hub for Google crawlers.
        routes.Add(new SsgRoute($"/{lang}/sitemap", "static"));
    }

    private async Task AddBookRoutesAsync(List<SsgRoute> routes, CancellationToken ct)
    {
        // Book detail pages are rendered for every Published edition, even
        // when Indexable == false. The renderer reads the same DB column and
        // emits <meta name="robots" content="noindex,follow"> in the HTML,
        // so search engines stay out while direct visitors (e.g. campaign
        // traffic) still get the static page. Filtering Indexable here
        // would just leave nginx serving a hard 404 for the slug.
        var query = _db.Editions
            .Where(e => e.Status == EditionStatus.Published);

        var books = await query
            .Select(e => new { e.Slug, e.Language })
            .ToListAsync(ct);

        routes.AddRange(books.Select(b => new SsgRoute($"/{b.Language}/books/{b.Slug}", "book")));
    }

    private async Task AddAuthorRoutesAsync(List<SsgRoute> routes, string lang, CancellationToken ct)
    {
        // `a.Indexable` is a manual hide override (admin UI). Default true.
        // See SsgEndpoints.GetAllRoutes for the 656-row backfill story —
        // same filter shape here on purpose: both route producers must agree
        // or the admin job count and the build-time prerender will drift.
        var query = _db.Authors
            .Where(a => a.Indexable)
            .Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Status == EditionStatus.Published &&
                ea.Edition.Indexable));

        var authors = await query.Select(a => a.Slug).ToListAsync(ct);
        routes.AddRange(authors.Select(a => new SsgRoute($"/{lang}/authors/{a}", "author")));
    }

    private async Task AddGenreRoutesAsync(List<SsgRoute> routes, string lang, CancellationToken ct)
    {
        var query = _db.Genres
            .Where(g => g.Indexable)
            .Where(g => g.Editions.Any(e =>
                e.Status == EditionStatus.Published &&
                e.Indexable));

        var genres = await query.Select(g => g.Slug).ToListAsync(ct);
        routes.AddRange(genres.Select(g => new SsgRoute($"/{lang}/genres/{g}", "genre")));
    }
}
