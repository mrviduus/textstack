using Api.Seo;
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
        app.MapGet("/sitemaps/pages.xml", (Delegate)GetPagesSitemap).WithName("GetPagesSitemap").WithTags("SEO");
        // NOTE: Chapters sitemap intentionally removed - chapters should not be indexed
    }

    private static IResult GetRobots(HttpContext httpContext)
    {
        var site = httpContext.GetSiteContext();
        var baseUrl = CanonicalUrlBuilder.GetCanonicalBase(site.PrimaryDomain);

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
            sb.AppendLine($"Sitemap: {baseUrl}/sitemap.xml");
        }

        return Results.Content(sb.ToString(), "text/plain");
    }

    private static Task<IResult> GetSitemapIndex(HttpContext httpContext)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Task.FromResult(Results.NotFound());

        var baseUrl = CanonicalUrlBuilder.GetCanonicalBase(site.PrimaryDomain);

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

        sb.AppendLine("  <sitemap>");
        sb.AppendLine($"    <loc>{baseUrl}/sitemaps/pages.xml</loc>");
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

        var books = await seoService.GetBooksForSitemapAsync(site.SiteId, ct);

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        // Only individual book detail pages - no homepage or list pages
        foreach (var book in books)
        {
            var loc = CanonicalUrlBuilder.BuildSitemapUrl(site.PrimaryDomain, $"/{book.Language}/books/{book.Slug}");
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{loc}</loc>");
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
            var loc = CanonicalUrlBuilder.BuildSitemapUrl(site.PrimaryDomain, $"/{site.DefaultLanguage}/authors/{author.Slug}");
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{loc}</loc>");
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
            var loc = CanonicalUrlBuilder.BuildSitemapUrl(site.PrimaryDomain, $"/{site.DefaultLanguage}/genres/{genre.Slug}");
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{loc}</loc>");
            sb.AppendLine($"    <lastmod>{genre.UpdatedAt:yyyy-MM-dd}</lastmod>");
            sb.AppendLine("    <changefreq>monthly</changefreq>");
            sb.AppendLine("  </url>");
        }

        sb.AppendLine("</urlset>");

        return Results.Content(sb.ToString(), "application/xml");
    }

    private static Task<IResult> GetPagesSitemap(HttpContext httpContext)
    {
        var site = httpContext.GetSiteContext();

        if (!site.SitemapEnabled)
            return Task.FromResult(Results.NotFound());

        var baseUrl = CanonicalUrlBuilder.GetCanonicalBase(site.PrimaryDomain);
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

        // Static pages for each supported language
        var languages = new[] { "en", "uk" };
        var listPages = new[] { "books", "authors", "genres", "about" };

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"");
        sb.AppendLine("        xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">");

        // Homepage for each language (with hreflang alternates)
        foreach (var lang in languages)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{lang}/</loc>");
            sb.AppendLine($"    <lastmod>{today}</lastmod>");
            sb.AppendLine("    <changefreq>daily</changefreq>");
            sb.AppendLine("    <priority>1.0</priority>");
            // Hreflang alternates
            foreach (var altLang in languages)
            {
                sb.AppendLine($"    <xhtml:link rel=\"alternate\" hreflang=\"{altLang}\" href=\"{baseUrl}/{altLang}/\" />");
            }
            sb.AppendLine($"    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"{baseUrl}/en/\" />");
            sb.AppendLine("  </url>");
        }

        // List pages (books, authors, genres) for each language
        foreach (var lang in languages)
        {
            foreach (var page in listPages)
            {
                sb.AppendLine("  <url>");
                sb.AppendLine($"    <loc>{baseUrl}/{lang}/{page}/</loc>");
                sb.AppendLine($"    <lastmod>{today}</lastmod>");
                sb.AppendLine("    <changefreq>daily</changefreq>");
                sb.AppendLine("    <priority>0.8</priority>");
                sb.AppendLine("  </url>");
            }
        }

        sb.AppendLine("</urlset>");

        return Task.FromResult(Results.Content(sb.ToString(), "application/xml"));
    }
}
