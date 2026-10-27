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
            .WithDescription("Create a Queued SSG rebuild job; ssg-worker claims it");

        group.MapGet("/jobs", GetJobs)
            .WithName("GetSsgRebuildJobs")
            .WithDescription("List SSG rebuild jobs");

        group.MapGet("/jobs/{id:guid}", GetJob)
            .WithName("GetSsgRebuildJob")
            .WithDescription("Get SSG rebuild job details");

        group.MapPost("/jobs/{id:guid}/cancel", CancelJob)
            .WithName("CancelSsgRebuildJob")
            .WithDescription("Cancel a running or queued SSG rebuild job");
    }

    private static async Task<IResult> GetPreview(
        [FromQuery] Guid siteId,
        ISsgJobService service = null!,
        CancellationToken ct = default)
    {
        var preview = await service.GetPreviewAsync(siteId, ct);

        return Results.Ok(preview);
    }

    private static async Task<IResult> CreateJob(
        [FromBody] CreateSsgRebuildJobRequest request,
        ISsgJobService service,
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
        ISsgJobService service = null!,
        CancellationToken ct = default)
    {
        var (total, items) = await service.GetJobsAsync(siteId, status, offset, limit, ct);
        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(
        Guid id,
        ISsgJobService service,
        CancellationToken ct)
    {
        var job = await service.GetJobAsync(id, ct);
        return job == null ? Results.NotFound() : Results.Ok(job);
    }

    private static async Task<IResult> CancelJob(
        Guid id,
        ISsgJobService service,
        CancellationToken ct)
    {
        var cancelled = await service.CancelJobAsync(id, ct);
        return cancelled ? Results.Ok() : Results.BadRequest(new { error = "Job not found or already completed" });
    }
}
