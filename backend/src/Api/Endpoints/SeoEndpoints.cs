using Api.Sites;
using Application.Common.Interfaces;
using Application.Seo;
using Microsoft.EntityFrameworkCore;
using System.Text;

namespace Api.Endpoints;

public static class SeoEndpoints
{
    private const int SitemapChunkSize = 10000;

    public static void MapSeoEndpoints(this WebApplication app)
    {
        app.MapGet("/robots.txt", GetRobots).WithName("GetRobots").WithTags("SEO");
        app.MapGet("/sitemap.xml", GetSitemapIndex).WithName("GetSitemapIndex").WithTags("SEO");
        app.MapGet("/sitemaps/books.xml", GetBooksSitemap).WithName("GetBooksSitemap").WithTags("SEO");
        app.MapGet("/sitemaps/chapters-{page:int}.xml", GetChaptersSitemap).WithName("GetChaptersSitemap").WithTags("SEO");
        app.MapGet("/sitemaps/authors.xml", GetAuthorsSitemap).WithName("GetAuthorsSitemap").WithTags("SEO");
        app.MapGet("/sitemaps/genres.xml", GetGenresSitemap).WithName("GetGenresSitemap").WithTags("SEO");
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

    private static async Task<IResult> GetSitemapIndex(
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

        var chapterCount = await seoService.GetChapterCountAsync(site.SiteId, ct);
        var chapterPages = (int)Math.Ceiling((double)chapterCount / SitemapChunkSize);

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

        for (int i = 1; i <= Math.Max(1, chapterPages); i++)
        {
            sb.AppendLine("  <sitemap>");
            sb.AppendLine($"    <loc>{baseUrl}/sitemaps/chapters-{i}.xml</loc>");
            sb.AppendLine("  </sitemap>");
        }

        sb.AppendLine("</sitemapindex>");

        return Results.Content(sb.ToString(), "application/xml");
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
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"");
        sb.AppendLine("        xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">");

        // Add homepage
        sb.AppendLine("  <url>");
        sb.AppendLine($"    <loc>{baseUrl}/{site.DefaultLanguage}</loc>");
        sb.AppendLine("    <changefreq>daily</changefreq>");
        sb.AppendLine("    <priority>1.0</priority>");
        sb.AppendLine("  </url>");

        foreach (var book in books)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{book.Language}/books/{book.Slug}</loc>");
            sb.AppendLine($"    <lastmod>{book.UpdatedAt:yyyy-MM-dd}</lastmod>");
            sb.AppendLine("    <changefreq>weekly</changefreq>");

            // Add hreflang for available translations
            foreach (var lang in book.AvailableLanguages)
            {
                sb.AppendLine($"    <xhtml:link rel=\"alternate\" hreflang=\"{lang}\" href=\"{baseUrl}/{lang}/books/{book.Slug}\" />");
            }
            sb.AppendLine($"    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"{baseUrl}/{book.Language}/books/{book.Slug}\" />");

            sb.AppendLine("  </url>");
        }

        sb.AppendLine("</urlset>");

        return Results.Content(sb.ToString(), "application/xml");
    }

    private static async Task<IResult> GetChaptersSitemap(
        int page,
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

        var chapters = await seoService.GetChaptersForSitemapAsync(site.SiteId, page, SitemapChunkSize, ct);

        if (chapters.Count == 0)
            return Results.NotFound();

        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");

        foreach (var chapter in chapters)
        {
            sb.AppendLine("  <url>");
            sb.AppendLine($"    <loc>{baseUrl}/{chapter.Language}/books/{chapter.BookSlug}/{chapter.Slug}</loc>");
            sb.AppendLine($"    <lastmod>{chapter.UpdatedAt:yyyy-MM-dd}</lastmod>");
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

        var authors = await db.Authors
            .Where(a => a.SiteId == site.SiteId && a.Indexable)
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

        var genres = await db.Genres
            .Where(g => g.SiteId == site.SiteId && g.Indexable)
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
