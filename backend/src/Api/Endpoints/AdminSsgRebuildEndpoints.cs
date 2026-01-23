using Application.SsgRebuild;
using Contracts.Admin;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AdminSsgRebuildEndpoints
{
    public static void MapAdminSsgRebuildEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/ssg").WithTags("SSG Rebuild");

        // Preview
        group.MapGet("/preview", GetPreview)
            .WithName("GetSsgRebuildPreview")
            .WithDescription("Preview route counts before creating job");

        // Jobs
        group.MapPost("/jobs", CreateJob)
            .WithName("CreateSsgRebuildJob")
            .WithDescription("Create a new SSG rebuild job");

        group.MapGet("/jobs", GetJobs)
            .WithName("GetSsgRebuildJobs")
            .WithDescription("List SSG rebuild jobs");

        group.MapGet("/jobs/{id:guid}", GetJob)
            .WithName("GetSsgRebuildJob")
            .WithDescription("Get SSG rebuild job details");

        group.MapPost("/jobs/{id:guid}/start", StartJob)
            .WithName("StartSsgRebuildJob")
            .WithDescription("Start a queued SSG rebuild job");

        group.MapPost("/jobs/{id:guid}/cancel", CancelJob)
            .WithName("CancelSsgRebuildJob")
            .WithDescription("Cancel a running or queued SSG rebuild job");

        // Results
        group.MapGet("/jobs/{id:guid}/stats", GetJobStats)
            .WithName("GetSsgRebuildJobStats")
            .WithDescription("Get statistics for a rebuild job");

        group.MapGet("/jobs/{id:guid}/results", GetResults)
            .WithName("GetSsgRebuildResults")
            .WithDescription("Get rebuild results with filtering");
    }

    private static async Task<IResult> GetPreview(
        [FromQuery] Guid siteId,
        [FromQuery] string mode = "Full",
        [FromQuery] string? bookSlugs = null,
        [FromQuery] string? authorSlugs = null,
        [FromQuery] string? genreSlugs = null,
        SsgRebuildService service = null!,
        CancellationToken ct = default)
    {
        var preview = await service.GetPreviewAsync(
            siteId,
            mode,
            ParseSlugs(bookSlugs),
            ParseSlugs(authorSlugs),
            ParseSlugs(genreSlugs),
            ct);

        return Results.Ok(preview);
    }

    private static async Task<IResult> CreateJob(
        [FromBody] CreateSsgRebuildJobRequest request,
        SsgRebuildService service,
        CancellationToken ct)
    {
        try
        {
            var job = await service.CreateJobAsync(request, ct);
            return Results.Created($"/admin/ssg/jobs/{job.Id}", new { id = job.Id });
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
        SsgRebuildService service = null!,
        CancellationToken ct = default)
    {
        var (total, items) = await service.GetJobsAsync(siteId, status, offset, limit, ct);
        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(
        Guid id,
        SsgRebuildService service,
        CancellationToken ct)
    {
        var job = await service.GetJobAsync(id, ct);
        return job == null ? Results.NotFound() : Results.Ok(job);
    }

    private static async Task<IResult> StartJob(
        Guid id,
        SsgRebuildService service,
        CancellationToken ct)
    {
        var started = await service.StartJobAsync(id, ct);
        return started ? Results.Ok() : Results.BadRequest(new { error = "Job not found or not in Queued status" });
    }

    private static async Task<IResult> CancelJob(
        Guid id,
        SsgRebuildService service,
        CancellationToken ct)
    {
        var cancelled = await service.CancelJobAsync(id, ct);
        return cancelled ? Results.Ok() : Results.BadRequest(new { error = "Job not found or already completed" });
    }

    private static async Task<IResult> GetJobStats(
        Guid id,
        SsgRebuildService service,
        CancellationToken ct)
    {
        var stats = await service.GetJobStatsAsync(id, ct);
        return stats == null ? Results.NotFound() : Results.Ok(stats);
    }

    private static async Task<IResult> GetResults(
        Guid id,
        [FromQuery] bool? failed,
        [FromQuery] string? routeType,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 50,
        SsgRebuildService service = null!,
        CancellationToken ct = default)
    {
        var filter = new SsgRebuildResultsFilter(failed, routeType, offset, limit);
        var (total, items) = await service.GetResultsAsync(id, filter, ct);
        return Results.Ok(new { total, items });
    }

    private static string[]? ParseSlugs(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        return value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }
}
