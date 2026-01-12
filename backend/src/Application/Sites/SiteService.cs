using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.Sites;

public record SiteListDto(
    Guid Id,
    string Code,
    string PrimaryDomain,
    string DefaultLanguage,
    string Theme,
    bool AdsEnabled,
    bool IndexingEnabled,
    bool SitemapEnabled,
    int MaxWordsPerPart,
    int DomainCount,
    int WorkCount
);

public record SiteDetailDto(
    Guid Id,
    string Code,
    string PrimaryDomain,
    string DefaultLanguage,
    string Theme,
    bool AdsEnabled,
    bool IndexingEnabled,
    bool SitemapEnabled,
    string FeaturesJson,
    int MaxWordsPerPart,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    List<SiteDomainDto> Domains
);

public record SiteDomainDto(Guid Id, string Domain, bool IsPrimary);

public record CreateSiteRequest(
    string Code,
    string PrimaryDomain,
    string DefaultLanguage,
    string? Theme,
    bool AdsEnabled,
    bool IndexingEnabled,
    bool SitemapEnabled,
    string? FeaturesJson
);

public record UpdateSiteRequest(
    string? PrimaryDomain,
    string? DefaultLanguage,
    string? Theme,
    bool? AdsEnabled,
    bool? IndexingEnabled,
    bool? SitemapEnabled,
    string? FeaturesJson,
    int? MaxWordsPerPart
);

public record AddDomainRequest(string Domain, bool IsPrimary);

public class SiteService(IAppDbContext db)
{
    public async Task<List<SiteListDto>> GetSitesAsync(CancellationToken ct)
    {
        return await db.Sites
            .OrderBy(s => s.Code)
            .Select(s => new SiteListDto(
                s.Id,
                s.Code,
                s.PrimaryDomain,
                s.DefaultLanguage,
                s.Theme,
                s.AdsEnabled,
                s.IndexingEnabled,
                s.SitemapEnabled,
                s.MaxWordsPerPart,
                s.Domains.Count,
                s.Works.Count
            ))
            .ToListAsync(ct);
    }

    public async Task<SiteDetailDto?> GetSiteAsync(Guid id, CancellationToken ct)
    {
        return await db.Sites
            .Where(s => s.Id == id)
            .Select(s => new SiteDetailDto(
                s.Id,
                s.Code,
                s.PrimaryDomain,
                s.DefaultLanguage,
                s.Theme,
                s.AdsEnabled,
                s.IndexingEnabled,
                s.SitemapEnabled,
                s.FeaturesJson,
                s.MaxWordsPerPart,
                s.CreatedAt,
                s.UpdatedAt,
                s.Domains.Select(d => new SiteDomainDto(d.Id, d.Domain, d.IsPrimary)).ToList()
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(bool Valid, string? Error)> ValidateCreateAsync(CreateSiteRequest req, CancellationToken ct)
    {
        if (await db.Sites.AnyAsync(s => s.Code == req.Code, ct))
            return (false, "Site code already exists");

        if (await db.Sites.AnyAsync(s => s.PrimaryDomain == req.PrimaryDomain, ct))
            return (false, "Primary domain already exists");

        return (true, null);
    }

    public async Task<Site> CreateSiteAsync(CreateSiteRequest req, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var site = new Site
        {
            Id = Guid.NewGuid(),
            Code = req.Code,
            PrimaryDomain = req.PrimaryDomain,
            DefaultLanguage = req.DefaultLanguage,
            Theme = req.Theme ?? "default",
            AdsEnabled = req.AdsEnabled,
            IndexingEnabled = req.IndexingEnabled,
            SitemapEnabled = req.SitemapEnabled,
            FeaturesJson = req.FeaturesJson ?? "{}",
            CreatedAt = now,
            UpdatedAt = now
        };

        db.Sites.Add(site);

        var domain = new SiteDomain
        {
            Id = Guid.NewGuid(),
            SiteId = site.Id,
            Domain = req.PrimaryDomain,
            IsPrimary = true,
            CreatedAt = now
        };
        db.SiteDomains.Add(domain);

        await db.SaveChangesAsync(ct);
        return site;
    }

    public async Task<(bool Found, string? Error)> UpdateSiteAsync(Guid id, UpdateSiteRequest req, CancellationToken ct)
    {
        var site = await db.Sites.FindAsync([id], ct);
        if (site is null)
            return (false, null);

        if (req.PrimaryDomain is not null)
        {
            if (await db.Sites.AnyAsync(s => s.Id != id && s.PrimaryDomain == req.PrimaryDomain, ct))
                return (true, "Primary domain already exists");
            site.PrimaryDomain = req.PrimaryDomain;
        }

        if (req.DefaultLanguage is not null)
            site.DefaultLanguage = req.DefaultLanguage;
        if (req.Theme is not null)
            site.Theme = req.Theme;
        if (req.AdsEnabled.HasValue)
            site.AdsEnabled = req.AdsEnabled.Value;
        if (req.IndexingEnabled.HasValue)
            site.IndexingEnabled = req.IndexingEnabled.Value;
        if (req.SitemapEnabled.HasValue)
            site.SitemapEnabled = req.SitemapEnabled.Value;
        if (req.FeaturesJson is not null)
            site.FeaturesJson = req.FeaturesJson;
        if (req.MaxWordsPerPart.HasValue)
            site.MaxWordsPerPart = req.MaxWordsPerPart.Value;

        site.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Found, string? Error)> DeleteSiteAsync(Guid id, CancellationToken ct)
    {
        var site = await db.Sites.FindAsync([id], ct);
        if (site is null)
            return (false, null);

        var hasWorks = await db.Works.AnyAsync(w => w.SiteId == id, ct);
        if (hasWorks)
            return (true, "Cannot delete site with existing works");

        db.Sites.Remove(site);
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<List<SiteDomainDto>> GetSiteDomainsAsync(Guid siteId, CancellationToken ct)
    {
        return await db.SiteDomains
            .Where(d => d.SiteId == siteId)
            .Select(d => new SiteDomainDto(d.Id, d.Domain, d.IsPrimary))
            .ToListAsync(ct);
    }

    public async Task<(bool Valid, string? Error, SiteDomain? Domain)> AddSiteDomainAsync(
        Guid siteId, AddDomainRequest req, CancellationToken ct)
    {
        if (!await db.Sites.AnyAsync(s => s.Id == siteId, ct))
            return (false, "Site not found", null);

        if (await db.SiteDomains.AnyAsync(d => d.Domain == req.Domain, ct))
            return (false, "Domain already exists", null);

        var domain = new SiteDomain
        {
            Id = Guid.NewGuid(),
            SiteId = siteId,
            Domain = req.Domain,
            IsPrimary = req.IsPrimary,
            CreatedAt = DateTimeOffset.UtcNow
        };

        db.SiteDomains.Add(domain);
        await db.SaveChangesAsync(ct);
        return (true, null, domain);
    }

    public async Task<bool> RemoveSiteDomainAsync(Guid siteId, Guid domainId, CancellationToken ct)
    {
        var domain = await db.SiteDomains.FirstOrDefaultAsync(d => d.Id == domainId && d.SiteId == siteId, ct);
        if (domain is null)
            return false;

        db.SiteDomains.Remove(domain);
        await db.SaveChangesAsync(ct);
        return true;
    }
}
