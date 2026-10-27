using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class AdminBookQualityEndpoints
{
    public static void MapAdminBookQualityEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/quality").WithTags("Book Quality");

        group.MapGet("/settings", GetSettings);
        group.MapPut("/settings", UpdateSettings);
        group.MapGet("/jobs", GetJobs);
        group.MapGet("/jobs/{id:guid}", GetJob);
        group.MapPost("/jobs", CreateJob);
        group.MapPost("/jobs/{id:guid}/cancel", CancelJob);
        group.MapPost("/jobs/{id:guid}/retry", RetryJob);
    }

    private static async Task<IResult> GetSettings(IAppDbContext db, CancellationToken ct)
    {
        var autoQueue = await GetSetting(db, "quality.autoQueueAfterIngestion", ct);
        var autoQueueUser = await GetSetting(db, "quality.autoQueueForUserBooks", ct);

        return Results.Ok(new
        {
            autoQueueAfterIngestion = autoQueue == "true",
            autoQueueForUserBooks = autoQueueUser == "true",
        });
    }

    private static async Task<IResult> UpdateSettings(
        [FromBody] QualitySettingsRequest req, IAppDbContext db, CancellationToken ct)
    {
        await SetSetting(db, "quality.autoQueueAfterIngestion", req.AutoQueueAfterIngestion ? "true" : "false", ct);
        await SetSetting(db, "quality.autoQueueForUserBooks", req.AutoQueueForUserBooks ? "true" : "false", ct);
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> GetJobs(
        IAppDbContext db,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 20,
        [FromQuery] string? status = null,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = db.BookQualityJobs.AsQueryable();
        if (status is not null && Enum.TryParse<BookQualityJobStatus>(status, true, out var s))
            query = query.Where(j => j.Status == s);

        var total = await query.CountAsync(ct);
        var items = await query.OrderByDescending(j => j.CreatedAt)
            .Skip(offset).Take(limit)
            .Select(j => new QualityJobListDto(
                j.Id, j.EditionId, j.UserBookId,
                j.Status.ToString(), j.IssuesFound, j.IssuesFixed,
                j.Error, j.CreatedAt, j.StartedAt, j.FinishedAt,
                j.Edition != null ? j.Edition.Title : null,
                j.UserBook != null ? j.UserBook.Title : null
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.BookQualityJobs
            .Include(j => j.Edition)
            .Include(j => j.UserBook)
            .FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        return Results.Ok(new QualityJobDetailDto(
            job.Id, job.EditionId, job.UserBookId,
            job.Status.ToString(), job.IssuesJson, job.IssuesFound, job.IssuesFixed,
            job.ContentChaptersCleaned, job.ContentChaptersRejected, job.ContentChaptersSkipped,
            job.Error, job.LogOutput,
            job.CreatedAt, job.StartedAt, job.FinishedAt,
            job.Edition?.Title, job.UserBook?.Title
        ));
    }

    private static async Task<IResult> CreateJob(
        [FromBody] CreateQualityJobRequest req, IAppDbContext db, CancellationToken ct)
    {
        if ((req.EditionId is null) == (req.UserBookId is null))
            return Results.BadRequest(new { error = "Exactly one of EditionId or UserBookId required" });

        var job = new BookQualityJob
        {
            Id = Guid.NewGuid(),
            EditionId = req.EditionId,
            UserBookId = req.UserBookId,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.BookQualityJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/admin/quality/jobs/{job.Id}", new { id = job.Id });
    }

    private static async Task<IResult> CancelJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.BookQualityJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();
        if (job.Status is BookQualityJobStatus.Completed or BookQualityJobStatus.Failed or BookQualityJobStatus.Cancelled)
            return Results.BadRequest(new { error = "Job already finished" });

        job.Status = BookQualityJobStatus.Cancelled;
        job.FinishedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> RetryJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.BookQualityJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();
        if (job.Status is not (BookQualityJobStatus.Completed or BookQualityJobStatus.Failed or BookQualityJobStatus.Cancelled))
            return Results.BadRequest(new { error = "Job is not in a terminal state" });

        job.Status = BookQualityJobStatus.Queued;
        job.Error = null;
        job.LogOutput = null;
        job.IssuesJson = null;
        job.IssuesFound = null;
        job.IssuesFixed = null;
        job.ContentChaptersCleaned = null;
        job.ContentChaptersRejected = null;
        job.ContentChaptersSkipped = null;
        job.StartedAt = null;
        job.FinishedAt = null;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    // Helpers

    private static async Task<string?> GetSetting(IAppDbContext db, string key, CancellationToken ct)
    {
        return await db.AdminSettings
            .Where(s => s.Key == key)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);
    }

    private static async Task SetSetting(IAppDbContext db, string key, string value, CancellationToken ct)
    {
        var setting = await db.AdminSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (setting is null)
        {
            db.AdminSettings.Add(new AdminSettings { Key = key, Value = value, UpdatedAt = DateTimeOffset.UtcNow });
        }
        else
        {
            setting.Value = value;
        }
    }
}

public record QualitySettingsRequest(bool AutoQueueAfterIngestion, bool AutoQueueForUserBooks);

public record CreateQualityJobRequest(Guid? EditionId = null, Guid? UserBookId = null);

public record QualityJobListDto(
    Guid Id, Guid? EditionId, Guid? UserBookId,
    string Status, int? IssuesFound, int? IssuesFixed,
    string? Error, DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt,
    string? EditionTitle, string? UserBookTitle);

public record QualityJobDetailDto(
    Guid Id, Guid? EditionId, Guid? UserBookId,
    string Status, string? IssuesJson, int? IssuesFound, int? IssuesFixed,
    int? ContentChaptersCleaned, int? ContentChaptersRejected, int? ContentChaptersSkipped,
    string? Error, string? LogOutput,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt,
    string? EditionTitle, string? UserBookTitle);
