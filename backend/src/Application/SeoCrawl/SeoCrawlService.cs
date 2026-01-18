using Application.Common.Interfaces;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.SeoCrawl;

public record SitemapUrl(string Url, string UrlType);

public class SeoCrawlService
{
    private readonly IAppDbContext _db;

    public SeoCrawlService(IAppDbContext db)
    {
        _db = db;
    }

    public async Task<List<SitemapUrl>> GetSitemapUrlsAsync(Guid siteId, CancellationToken ct)
    {
        var site = await _db.Sites.FirstOrDefaultAsync(s => s.Id == siteId, ct);
        if (site == null)
            return [];

        var baseUrl = $"https://{site.PrimaryDomain}";
        var urls = new List<SitemapUrl>();

        // Books - same logic as SeoEndpoints.GetBooksSitemap
        var books = await _db.Editions
            .Where(e => e.SiteId == siteId && e.Status == EditionStatus.Published && e.Indexable)
            .Select(e => new { e.Slug, e.Language })
            .ToListAsync(ct);

        urls.AddRange(books.Select(b => new SitemapUrl($"{baseUrl}/{b.Language}/books/{b.Slug}", "book")));

        // Authors - same logic as SeoEndpoints.GetAuthorsSitemap
        var authors = await _db.Authors
            .Where(a => a.SiteId == siteId && a.Indexable)
            .Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Status == EditionStatus.Published &&
                ea.Edition.Indexable))
            .Select(a => a.Slug)
            .ToListAsync(ct);

        urls.AddRange(authors.Select(a => new SitemapUrl($"{baseUrl}/{site.DefaultLanguage}/authors/{a}", "author")));

        // Genres - same logic as SeoEndpoints.GetGenresSitemap
        var genres = await _db.Genres
            .Where(g => g.SiteId == siteId && g.Indexable)
            .Where(g => g.Editions.Any(e =>
                e.Status == EditionStatus.Published &&
                e.Indexable))
            .Select(g => g.Slug)
            .ToListAsync(ct);

        urls.AddRange(genres.Select(g => new SitemapUrl($"{baseUrl}/{site.DefaultLanguage}/genres/{g}", "genre")));

        return urls;
    }

    public async Task<int> GetSitemapUrlCountAsync(Guid siteId, CancellationToken ct)
    {
        var urls = await GetSitemapUrlsAsync(siteId, ct);
        return urls.Count;
    }

    public async Task<SeoCrawlJob> CreateJobAsync(CreateSeoCrawlJobRequest request, CancellationToken ct)
    {
        // Validate site exists
        var siteExists = await _db.Sites.AnyAsync(s => s.Id == request.SiteId, ct);
        if (!siteExists)
            throw new ArgumentException($"Site with ID {request.SiteId} not found");

        var job = new SeoCrawlJob
        {
            Id = Guid.NewGuid(),
            SiteId = request.SiteId,
            MaxPages = request.MaxPages ?? 500,
            CrawlDelayMs = request.CrawlDelayMs ?? 200,
            Concurrency = request.Concurrency ?? 4,
            UserAgent = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            Status = SeoCrawlJobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.SeoCrawlJobs.Add(job);
        await _db.SaveChangesAsync(ct);
        return job;
    }

    public async Task<SeoCrawlJobDetailDto?> GetJobAsync(Guid id, CancellationToken ct)
    {
        var job = await _db.SeoCrawlJobs
            .AsNoTracking()
            .Include(j => j.Site)
            .FirstOrDefaultAsync(j => j.Id == id, ct);

        return job == null ? null : MapToDetail(job);
    }

    public async Task<(int Total, List<SeoCrawlJobListDto> Items)> GetJobsAsync(
        Guid? siteId, string? status, int offset, int limit, CancellationToken ct)
    {
        var query = _db.SeoCrawlJobs
            .AsNoTracking()
            .Include(j => j.Site)
            .AsQueryable();

        if (siteId.HasValue)
            query = query.Where(j => j.SiteId == siteId.Value);

        if (!string.IsNullOrEmpty(status) && Enum.TryParse<SeoCrawlJobStatus>(status, true, out var statusEnum))
            query = query.Where(j => j.Status == statusEnum);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(j => j.CreatedAt)
            .Skip(offset)
            .Take(Math.Min(limit, 100))
            .Select(j => new SeoCrawlJobListDto(
                j.Id,
                j.SiteId,
                j.Site.Code,
                j.Status.ToString(),
                j.TotalUrls,
                j.MaxPages,
                j.PagesCrawled,
                j.ErrorsCount,
                j.CreatedAt,
                j.StartedAt,
                j.FinishedAt
            ))
            .ToListAsync(ct);

        return (total, items);
    }

    public async Task<bool> StartJobAsync(Guid id, CancellationToken ct)
    {
        var job = await _db.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null || job.Status != SeoCrawlJobStatus.Queued)
            return false;

        job.Status = SeoCrawlJobStatus.Running;
        job.StartedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> CancelJobAsync(Guid id, CancellationToken ct)
    {
        var job = await _db.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null)
            return false;

        if (job.Status == SeoCrawlJobStatus.Queued || job.Status == SeoCrawlJobStatus.Running)
        {
            job.Status = SeoCrawlJobStatus.Cancelled;
            job.FinishedAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(ct);
            return true;
        }

        return false;
    }

    public async Task<SeoCrawlJobStatsDto?> GetJobStatsAsync(Guid jobId, CancellationToken ct)
    {
        var jobExists = await _db.SeoCrawlJobs.AnyAsync(j => j.Id == jobId, ct);
        if (!jobExists)
            return null;

        var results = _db.SeoCrawlResults
            .AsNoTracking()
            .Where(r => r.JobId == jobId);

        return new SeoCrawlJobStatsDto(
            Total: await results.CountAsync(ct),
            Status2xx: await results.CountAsync(r => r.StatusCode >= 200 && r.StatusCode < 300, ct),
            Status3xx: await results.CountAsync(r => r.StatusCode >= 300 && r.StatusCode < 400, ct),
            Status4xx: await results.CountAsync(r => r.StatusCode >= 400 && r.StatusCode < 500, ct),
            Status5xx: await results.CountAsync(r => r.StatusCode >= 500, ct),
            MissingTitle: await results.CountAsync(r => r.Title == null && r.StatusCode >= 200 && r.StatusCode < 300, ct),
            MissingDescription: await results.CountAsync(r => r.MetaDescription == null && r.StatusCode >= 200 && r.StatusCode < 300, ct),
            MissingH1: await results.CountAsync(r => r.H1 == null && r.StatusCode >= 200 && r.StatusCode < 300, ct),
            NoIndex: await results.CountAsync(r => r.MetaRobots != null && r.MetaRobots.Contains("noindex"), ct)
        );
    }

    public async Task<(int Total, List<SeoCrawlResultDto> Items)> GetResultsAsync(
        Guid jobId, SeoCrawlResultsFilter filter, CancellationToken ct)
    {
        var query = _db.SeoCrawlResults
            .AsNoTracking()
            .Where(r => r.JobId == jobId);

        if (filter.StatusCodeMin.HasValue)
            query = query.Where(r => r.StatusCode >= filter.StatusCodeMin.Value);

        if (filter.StatusCodeMax.HasValue)
            query = query.Where(r => r.StatusCode < filter.StatusCodeMax.Value);

        if (filter.MissingTitle == true)
            query = query.Where(r => r.Title == null && r.StatusCode >= 200 && r.StatusCode < 300);

        if (filter.MissingDescription == true)
            query = query.Where(r => r.MetaDescription == null && r.StatusCode >= 200 && r.StatusCode < 300);

        if (filter.MissingH1 == true)
            query = query.Where(r => r.H1 == null && r.StatusCode >= 200 && r.StatusCode < 300);

        if (filter.HasError == true)
            query = query.Where(r => r.FetchError != null);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderBy(r => r.UrlType)
            .ThenBy(r => r.Url)
            .Skip(filter.Offset)
            .Take(Math.Min(filter.Limit, 100))
            .Select(r => new SeoCrawlResultDto(
                r.Id,
                r.Url,
                r.UrlType,
                r.StatusCode,
                r.ContentType,
                r.HtmlBytes,
                r.Title,
                r.MetaDescription,
                r.H1,
                r.Canonical,
                r.MetaRobots,
                r.XRobotsTag,
                r.FetchedAt,
                r.FetchError
            ))
            .ToListAsync(ct);

        return (total, items);
    }

    public async Task<string> ExportResultsCsvAsync(Guid jobId, CancellationToken ct)
    {
        var results = await _db.SeoCrawlResults
            .AsNoTracking()
            .Where(r => r.JobId == jobId)
            .OrderBy(r => r.UrlType)
            .ThenBy(r => r.Url)
            .ToListAsync(ct);

        var csv = new System.Text.StringBuilder();
        csv.AppendLine("URL,Type,Status Code,Content Type,Title,Meta Description,H1,Canonical,Meta Robots,X-Robots-Tag,Fetched At,Error");

        foreach (var r in results)
        {
            csv.AppendLine(string.Join(",",
                Escape(r.Url),
                Escape(r.UrlType),
                r.StatusCode?.ToString() ?? "",
                Escape(r.ContentType),
                Escape(r.Title),
                Escape(r.MetaDescription),
                Escape(r.H1),
                Escape(r.Canonical),
                Escape(r.MetaRobots),
                Escape(r.XRobotsTag),
                r.FetchedAt.ToString("o"),
                Escape(r.FetchError)
            ));
        }

        return csv.ToString();
    }

    private static string Escape(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return "";
        if (value.Contains(',') || value.Contains('"') || value.Contains('\n'))
            return $"\"{value.Replace("\"", "\"\"")}\"";
        return value;
    }

    private static SeoCrawlJobDetailDto MapToDetail(SeoCrawlJob job)
    {
        return new SeoCrawlJobDetailDto(
            job.Id,
            job.SiteId,
            job.Site.Code,
            job.MaxPages,
            job.CrawlDelayMs,
            job.Concurrency,
            job.UserAgent,
            job.Status.ToString(),
            job.TotalUrls,
            job.PagesCrawled,
            job.ErrorsCount,
            job.Error,
            job.CreatedAt,
            job.StartedAt,
            job.FinishedAt
        );
    }
}
