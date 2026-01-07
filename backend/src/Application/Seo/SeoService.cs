using Application.Common.Interfaces;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.Seo;

public record SitemapBookDto(string Slug, string Language, DateTimeOffset UpdatedAt, List<string> AvailableLanguages);
public record SitemapChapterDto(string BookSlug, string Slug, string Language, DateTimeOffset UpdatedAt);

public class SeoService(IAppDbContext db)
{
    public async Task<int> GetChapterCountAsync(Guid siteId, CancellationToken ct)
    {
        return await db.Chapters
            .Where(c => c.Edition.SiteId == siteId && c.Edition.Status == EditionStatus.Published && c.Edition.Indexable)
            .CountAsync(ct);
    }

    public async Task<List<SitemapBookDto>> GetBooksForSitemapAsync(Guid siteId, CancellationToken ct)
    {
        // Get all editions with their Work's other editions
        var editions = await db.Editions
            .Where(e => e.SiteId == siteId && e.Status == EditionStatus.Published && e.Indexable)
            .Include(e => e.Work)
                .ThenInclude(w => w.Editions.Where(oe => oe.Status == EditionStatus.Published && oe.Indexable))
            .OrderByDescending(e => e.UpdatedAt)
            .ToListAsync(ct);

        return editions.Select(e => new SitemapBookDto(
            e.Slug,
            e.Language,
            e.UpdatedAt,
            e.Work.Editions.Select(oe => oe.Language).Distinct().ToList()
        )).ToList();
    }

    public async Task<List<SitemapChapterDto>> GetChaptersForSitemapAsync(
        Guid siteId, int page, int pageSize, CancellationToken ct)
    {
        return await db.Chapters
            .Where(c => c.Edition.SiteId == siteId && c.Edition.Status == EditionStatus.Published && c.Edition.Indexable)
            .OrderBy(c => c.Edition.Slug)
            .ThenBy(c => c.ChapterNumber)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(c => new SitemapChapterDto(c.Edition.Slug, c.Slug ?? "", c.Edition.Language, c.Edition.UpdatedAt))
            .ToListAsync(ct);
    }
}
