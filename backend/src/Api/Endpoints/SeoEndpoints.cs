using Api.Sites;
using Application.Common.Interfaces;
using Application.Seo;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using System.Text;

namespace Api.Endpoints;

public static class SeoEndpoints
{
    public static void MapSeoEndpoints(this WebApplication app)
    {
        app.MapGet("/robots.txt", GetRobots).WithName("GetRobots").WithTags("SEO");
        app.MapGet("/sitemap.xml", (Delegate)GetSitemapIndex).WithName("GetSitemapIndex").WithTags("SEO");
        app.MapGet("/sitemaps/books.xml", GetBooksSitemap).WithName("GetBooksSitemap").WithTags("SEO");
        app.MapGet("/sitemaps/authors.xml", GetAuthorsSitemap).WithName("GetAuthorsSitemap").WithTags("SEO");
        app.MapGet("/sitemaps/genres.xml", GetGenresSitemap).WithName("GetGenresSitemap").WithTags("SEO");
        // NOTE: Chapters sitemap intentionally removed - chapters should not be indexed
    }

    private static IResult GetRobots(HttpContext httpContext)
    {
        var site = httpContext.GetSiteContext();
        var host = httpContext.Request.Host.Value;
        var scheme = httpContext.Request.Scheme;

        var sb = new StringBuilder();
        sb.AppendLine("User-agent: *");

        if (!site.IndexingEnabled)
        {
            sb.AppendLine("Disallow: /");
        }
        else
        {
            sb.AppendLine("Disallow: /admin");
            sb.AppendLine("Disallow: /api/");
            sb.AppendLine();
            sb.AppendLine($"Sitemap: {scheme}://{host}/sitemap.xml");
        }

        return Results.Content(sb.ToString(), "text/plain");
    }

    private static Task<IResult> GetSitemapIndex(HttpContext httpContext)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Task.FromResult(Results.NotFound());

        var host = httpContext.Request.Host.Value;
        var scheme = httpContext.Request.Scheme;
        var baseUrl = $"{scheme}://{host}";

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        sb.AppendLine("  <sitemap>");
        sb.AppendLine($"    <loc>{baseUrl}/sitemaps/books.xml</loc>");
        sb.AppendLine("  </sitemap>");

        sb.AppendLine("  <sitemap>");
        sb.AppendLine($"    <loc>{baseUrl}/sitemaps/authors.xml</loc>");
        sb.AppendLine("  </sitemap>");

        sb.AppendLine("  <sitemap>");
        sb.AppendLine($"    <loc>{baseUrl}/sitemaps/genres.xml</loc>");
        sb.AppendLine("  </sitemap>");

        // NOTE: Chapters sitemap intentionally excluded - chapters are noindex
        sb.AppendLine("</sitemapindex>");

        return Task.FromResult(Results.Content(sb.ToString(), "application/xml"));
    }

    private static async Task<IResult> GetBooksSitemap(
        HttpContext httpContext,
        SeoService seoService,
        CancellationToken ct)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Results.NotFound();

        var host = httpContext.Request.Host.Value;
        var scheme = httpContext.Request.Scheme;
        var baseUrl = $"{scheme}://{host}";

        var books = await seoService.GetBooksForSitemapAsync(site.SiteId, ct);

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        // Only individual book detail pages - no homepage or list pages
        foreach (var book in books)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{book.Language}/books/{book.Slug}</loc>");
            sb.AppendLine($"    <lastmod>{book.UpdatedAt:yyyy-MM-dd}</lastmod>");
            sb.AppendLine("  </url>");
        }

        sb.AppendLine("</urlset>");

        return Results.Content(sb.ToString(), "application/xml");
    }

    private static async Task<IResult> GetAuthorsSitemap(
        HttpContext httpContext,
        IAppDbContext db,
        CancellationToken ct)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Results.NotFound();

        var host = httpContext.Request.Host.Value;
        var scheme = httpContext.Request.Scheme;
        var baseUrl = $"{scheme}://{host}";

        // Only include authors who have at least one published book
        var authors = await db.Authors
            .Where(a => a.SiteId == site.SiteId && a.Indexable)
            .Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Status == EditionStatus.Published &&
                ea.Edition.Indexable))
            .OrderBy(a => a.Name)
            .Select(a => new { a.Slug, a.UpdatedAt })
            .ToListAsync(ct);

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        foreach (var author in authors)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{site.DefaultLanguage}/authors/{author.Slug}</loc>");
            sb.AppendLine($"    <lastmod>{author.UpdatedAt:yyyy-MM-dd}</lastmod>");
            sb.AppendLine("    <changefreq>monthly</changefreq>");
            sb.AppendLine("  </url>");
        }

        sb.AppendLine("</urlset>");

        return Results.Content(sb.ToString(), "application/xml");
    }

    private static async Task<IResult> GetGenresSitemap(
        HttpContext httpContext,
        IAppDbContext db,
        CancellationToken ct)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Results.NotFound();

        var host = httpContext.Request.Host.Value;
        var scheme = httpContext.Request.Scheme;
        var baseUrl = $"{scheme}://{host}";

        // Only include genres that have at least one published book
        var genres = await db.Genres
            .Where(g => g.SiteId == site.SiteId && g.Indexable)
            .Where(g => g.Editions.Any(e =>
                e.Status == EditionStatus.Published &&
                e.Indexable))
            .OrderBy(g => g.Name)
            .Select(g => new { g.Slug, g.UpdatedAt })
            .ToListAsync(ct);

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        foreach (var genre in genres)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{site.DefaultLanguage}/genres/{genre.Slug}</loc>");
            sb.AppendLine($"    <lastmod>{genre.UpdatedAt:yyyy-MM-dd}</lastmod>");
            sb.AppendLine("    <changefreq>monthly</changefreq>");
            sb.AppendLine("  </url>");
        }

        sb.AppendLine("</urlset>");

        return Results.Content(sb.ToString(), "application/xml");
    }
}
