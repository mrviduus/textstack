using System.Diagnostics;
using Application.SeoCrawl;
using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class SeoCrawlWorkerService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SeoCrawlWorkerService> _logger;

    public SeoCrawlWorkerService(
        IDbContextFactory<AppDbContext> dbFactory,
        IHttpClientFactory httpClientFactory,
        ILogger<SeoCrawlWorkerService> logger)
    {
        _dbFactory = dbFactory;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<SeoCrawlJob?> GetNextJobAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.SeoCrawlJobs
            .Where(j => j.Status == SeoCrawlJobStatus.Running)
            .OrderBy(j => j.StartedAt)
            .FirstOrDefaultAsync(ct);
    }

    public async Task ProcessJobAsync(Guid jobId, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var job = await db.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job == null)
        {
            _logger.LogWarning("Job {JobId} not found", jobId);
            return;
        }

        if (job.Status != SeoCrawlJobStatus.Running)
        {
            _logger.LogWarning("Job {JobId} is not in Running status (was {Status})", jobId, job.Status);
            return;
        }

        _logger.LogInformation("Starting sitemap crawl for job {JobId}, site {SiteId}, max {MaxPages} pages",
            jobId, job.SiteId, job.MaxPages);

        try
        {
            await CrawlSitemapAsync(job, ct);

            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SeoCrawlJobStatus.Completed;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogInformation("Crawl completed for job {JobId}", jobId);
        }
        catch (OperationCanceledException)
        {
            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SeoCrawlJobStatus.Cancelled;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogInformation("Crawl cancelled for job {JobId}", jobId);
        }
        catch (Exception ex)
        {
            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SeoCrawlJobStatus.Failed;
                jobToUpdate.Error = ex.Message;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogError(ex, "Crawl failed for job {JobId}", jobId);
        }
    }

    private async Task CrawlSitemapAsync(SeoCrawlJob job, CancellationToken ct)
    {
        // Get sitemap URLs from DB
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var service = new SeoCrawlService(db);
        var sitemapUrls = await service.GetSitemapUrlsAsync(job.SiteId, ct);

        // Limit to MaxPages
        var urlsToProcess = sitemapUrls.Take(job.MaxPages).ToList();

        // Update total URLs on job
        await UpdateJobTotalUrlsAsync(job.Id, urlsToProcess.Count, ct);

        var semaphore = new SemaphoreSlim(job.Concurrency);
        var httpClient = CreateHttpClient(job);

        var pagesCrawled = 0;
        var errorsCount = 0;

        // Process in batches
        for (var i = 0; i < urlsToProcess.Count && !ct.IsCancellationRequested; i += job.Concurrency)
        {
            var batch = urlsToProcess.Skip(i).Take(job.Concurrency).ToList();

            var tasks = batch.Select(async sitemapUrl =>
            {
                await semaphore.WaitAsync(ct);
                try
                {
                    var result = await FetchAndParseAsync(sitemapUrl.Url, sitemapUrl.UrlType, httpClient, ct);
                    await SaveResultAsync(job.Id, result, ct);

                    Interlocked.Increment(ref pagesCrawled);
                    if (result.FetchError != null)
                        Interlocked.Increment(ref errorsCount);
                }
                finally
                {
                    semaphore.Release();
                }
            });

            await Task.WhenAll(tasks);

            // Update job progress
            await UpdateJobProgressAsync(job.Id, pagesCrawled, errorsCount, ct);

            if (job.CrawlDelayMs > 0 && !ct.IsCancellationRequested && i + job.Concurrency < urlsToProcess.Count)
                await Task.Delay(job.CrawlDelayMs, ct);
        }
    }

    private async Task<CrawlResult> FetchAndParseAsync(string url, string urlType, HttpClient httpClient, CancellationToken ct)
    {
        var result = new CrawlResult
        {
            Url = url,
            UrlType = urlType,
            FetchedAt = DateTimeOffset.UtcNow
        };

        var sw = Stopwatch.StartNew();

        try
        {
            using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            result.StatusCode = (int)response.StatusCode;
            result.ContentType = response.Content.Headers.ContentType?.MediaType;

            if (response.Headers.TryGetValues("X-Robots-Tag", out var xRobotsValues))
                result.XRobotsTag = string.Join(", ", xRobotsValues);

            if (result.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) == true)
            {
                var html = await response.Content.ReadAsStringAsync(ct);
                result.HtmlBytes = html.Length;

                var seoData = HtmlSeoParser.Parse(html, url);
                result.Title = seoData.Title;
                result.MetaDescription = seoData.MetaDescription;
                result.H1 = seoData.H1;
                result.Canonical = seoData.Canonical;
                result.MetaRobots = seoData.MetaRobots;
            }
        }
        catch (HttpRequestException ex)
        {
            result.FetchError = ex.Message;
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            result.FetchError = "Request timeout";
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            result.FetchError = ex.Message;
        }

        sw.Stop();
        _logger.LogDebug("Fetched {Url} ({UrlType}) in {ElapsedMs}ms - Status: {StatusCode}",
            url, urlType, sw.ElapsedMilliseconds, result.StatusCode);

        return result;
    }

    private async Task SaveResultAsync(Guid jobId, CrawlResult result, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var entity = new SeoCrawlResult
        {
            Id = Guid.NewGuid(),
            JobId = jobId,
            Url = result.Url,
            UrlType = result.UrlType,
            StatusCode = result.StatusCode,
            ContentType = result.ContentType,
            HtmlBytes = result.HtmlBytes,
            Title = result.Title,
            MetaDescription = result.MetaDescription,
            H1 = result.H1,
            Canonical = result.Canonical,
            MetaRobots = result.MetaRobots,
            XRobotsTag = result.XRobotsTag,
            FetchedAt = result.FetchedAt,
            FetchError = result.FetchError
        };

        db.SeoCrawlResults.Add(entity);
        await db.SaveChangesAsync(ct);
    }

    private async Task UpdateJobTotalUrlsAsync(Guid jobId, int totalUrls, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var job = await db.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job != null)
        {
            job.TotalUrls = totalUrls;
            await db.SaveChangesAsync(ct);
        }
    }

    private async Task UpdateJobProgressAsync(Guid jobId, int pagesCrawled, int errorsCount, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var job = await db.SeoCrawlJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job != null)
        {
            job.PagesCrawled = pagesCrawled;
            job.ErrorsCount = errorsCount;
            await db.SaveChangesAsync(ct);
        }
    }

    private HttpClient CreateHttpClient(SeoCrawlJob job)
    {
        var client = _httpClientFactory.CreateClient("SeoCrawl");
        client.DefaultRequestHeaders.UserAgent.ParseAdd(job.UserAgent);
        client.DefaultRequestHeaders.Accept.ParseAdd("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-US,en;q=0.9");
        client.Timeout = TimeSpan.FromSeconds(15);
        return client;
    }

    private class CrawlResult
    {
        public string Url { get; set; } = "";
        public string UrlType { get; set; } = "";
        public int? StatusCode { get; set; }
        public string? ContentType { get; set; }
        public int? HtmlBytes { get; set; }
        public string? Title { get; set; }
        public string? MetaDescription { get; set; }
        public string? H1 { get; set; }
        public string? Canonical { get; set; }
        public string? MetaRobots { get; set; }
        public string? XRobotsTag { get; set; }
        public DateTimeOffset FetchedAt { get; set; }
        public string? FetchError { get; set; }
    }
}
