using Application.Common.Interfaces;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.Seo;

public record SitemapBookDto(string Slug, string Language, DateTimeOffset UpdatedAt, List<string> AvailableLanguages);

public class SeoService(IAppDbContext db)
{
    public async Task<List<SitemapBookDto>> GetBooksForSitemapAsync(Guid siteId, CancellationToken ct)
    {
        // Get all published, indexable editions with their Work's other editions
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
}
