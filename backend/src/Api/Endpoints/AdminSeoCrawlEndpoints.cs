using Application.SeoCrawl;
using Contracts.Admin;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AdminSeoCrawlEndpoints
{
    public static void MapAdminSeoCrawlEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/seo-crawl").WithTags("SEO Crawl");

        // Preview - get URL count before creating job
        group.MapGet("/preview", GetPreview)
            .WithName("GetSeoCrawlPreview")
            .WithDescription("Preview sitemap URLs count for a site");

        // Jobs
        group.MapPost("/jobs", CreateJob)
            .WithName("CreateSeoCrawlJob")
            .WithDescription("Create a new SEO crawl job");

        group.MapGet("/jobs", GetJobs)
            .WithName("GetSeoCrawlJobs")
            .WithDescription("List SEO crawl jobs");

        group.MapGet("/jobs/{id:guid}", GetJob)
            .WithName("GetSeoCrawlJob")
            .WithDescription("Get SEO crawl job details");

        group.MapPost("/jobs/{id:guid}/start", StartJob)
            .WithName("StartSeoCrawlJob")
            .WithDescription("Start a queued SEO crawl job");

        group.MapPost("/jobs/{id:guid}/cancel", CancelJob)
            .WithName("CancelSeoCrawlJob")
            .WithDescription("Cancel a running or queued SEO crawl job");

        // Results
        group.MapGet("/jobs/{id:guid}/stats", GetJobStats)
            .WithName("GetSeoCrawlJobStats")
            .WithDescription("Get statistics for a crawl job");

        group.MapGet("/jobs/{id:guid}/results", GetResults)
            .WithName("GetSeoCrawlResults")
            .WithDescription("Get crawl results with filtering");

        group.MapGet("/jobs/{id:guid}/export.csv", ExportCsv)
            .WithName("ExportSeoCrawlCsv")
            .WithDescription("Export crawl results as CSV");
    }

    private static async Task<IResult> GetPreview(
        [FromQuery] Guid siteId,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var urls = await service.GetSitemapUrlsAsync(siteId, ct);
        return Results.Ok(new SeoCrawlPreviewDto(
            TotalUrls: urls.Count,
            BookCount: urls.Count(u => u.UrlType == "book"),
            AuthorCount: urls.Count(u => u.UrlType == "author"),
            GenreCount: urls.Count(u => u.UrlType == "genre")
        ));
    }

    private static async Task<IResult> CreateJob(
        [FromBody] CreateSeoCrawlJobRequest request,
        SeoCrawlService service,
        CancellationToken ct)
    {
        try
        {
            var job = await service.CreateJobAsync(request, ct);
            return Results.Created($"/admin/seo-crawl/jobs/{job.Id}", new { id = job.Id });
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    private static async Task<IResult> GetJobs(
        [FromQuery] Guid? siteId,
        [FromQuery] string? status,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 20,
        SeoCrawlService service = null!,
        CancellationToken ct = default)
    {
        var (total, items) = await service.GetJobsAsync(siteId, status, offset, limit, ct);
        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(
        Guid id,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var job = await service.GetJobAsync(id, ct);
        return job == null ? Results.NotFound() : Results.Ok(job);
    }

    private static async Task<IResult> StartJob(
        Guid id,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var started = await service.StartJobAsync(id, ct);
        return started ? Results.Ok() : Results.BadRequest(new { error = "Job not found or not in Queued status" });
    }

    private static async Task<IResult> CancelJob(
        Guid id,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var cancelled = await service.CancelJobAsync(id, ct);
        return cancelled ? Results.Ok() : Results.BadRequest(new { error = "Job not found or already completed" });
    }

    private static async Task<IResult> GetJobStats(
        Guid id,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var stats = await service.GetJobStatsAsync(id, ct);
        return stats == null ? Results.NotFound() : Results.Ok(stats);
    }

    private static async Task<IResult> GetResults(
        Guid id,
        [FromQuery] int? statusCodeMin,
        [FromQuery] int? statusCodeMax,
        [FromQuery] bool? missingTitle,
        [FromQuery] bool? missingDescription,
        [FromQuery] bool? missingH1,
        [FromQuery] bool? hasError,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 50,
        SeoCrawlService service = null!,
        CancellationToken ct = default)
    {
        var filter = new SeoCrawlResultsFilter(
            statusCodeMin, statusCodeMax,
            missingTitle, missingDescription, missingH1, hasError,
            offset, limit
        );

        var (total, items) = await service.GetResultsAsync(id, filter, ct);
        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> ExportCsv(
        Guid id,
        SeoCrawlService service,
        CancellationToken ct)
    {
        var csv = await service.ExportResultsCsvAsync(id, ct);
        return Results.Text(csv, "text/csv", System.Text.Encoding.UTF8);
    }
}
