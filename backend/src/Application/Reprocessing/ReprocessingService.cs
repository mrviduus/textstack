using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Application.Reprocessing;

public record ReprocessingResult(
    int TotalEditions,
    int JobsQueued,
    int Skipped,
    List<ReprocessedEditionInfo> Editions
);

public record ReprocessedEditionInfo(
    Guid EditionId,
    string Title,
    Guid? JobId,
    string Status,
    string? Error
);

public class ReprocessingService(IAppDbContext db, ILogger<ReprocessingService> logger)
{
    /// <summary>
    /// Queue re-processing for a single edition
    /// </summary>
    public async Task<ReprocessedEditionInfo> ReprocessEditionAsync(Guid editionId, CancellationToken ct)
    {
        var edition = await db.Editions
            .Include(e => e.BookFiles)
            .FirstOrDefaultAsync(e => e.Id == editionId, ct);

        if (edition is null)
            return new ReprocessedEditionInfo(editionId, "Unknown", null, "Error", "Edition not found");

        return await QueueReprocessingAsync(edition, ct);
    }

    /// <summary>
    /// Queue re-processing for all published editions
    /// </summary>
    public async Task<ReprocessingResult> ReprocessAllEditionsAsync(Guid? siteId, CancellationToken ct)
    {
        var query = db.Editions
            .Include(e => e.BookFiles)
            .Where(e => e.Status == EditionStatus.Published);

        if (siteId.HasValue)
            query = query.Where(e => e.SiteId == siteId.Value);

        var editions = await query.ToListAsync(ct);

        var results = new List<ReprocessedEditionInfo>();
        var jobsQueued = 0;
        var skipped = 0;

        foreach (var edition in editions)
        {
            var result = await QueueReprocessingAsync(edition, ct);
            results.Add(result);

            if (result.JobId.HasValue)
                jobsQueued++;
            else
                skipped++;
        }

        return new ReprocessingResult(editions.Count, jobsQueued, skipped, results);
    }

    private async Task<ReprocessedEditionInfo> QueueReprocessingAsync(Edition edition, CancellationToken ct)
    {
        // Find the most recent book file for this edition
        var bookFile = edition.BookFiles
            .OrderByDescending(bf => bf.UploadedAt)
            .FirstOrDefault();

        if (bookFile is null)
        {
            logger.LogWarning("Edition {EditionId} has no book files, skipping", edition.Id);
            return new ReprocessedEditionInfo(edition.Id, edition.Title, null, "Skipped", "No book file found");
        }

        // Check if there's already a queued or processing job
        var existingJob = await db.IngestionJobs
            .Where(j => j.EditionId == edition.Id && (j.Status == JobStatus.Queued || j.Status == JobStatus.Processing))
            .FirstOrDefaultAsync(ct);

        if (existingJob is not null)
        {
            logger.LogInformation("Edition {EditionId} already has a pending job {JobId}", edition.Id, existingJob.Id);
            return new ReprocessedEditionInfo(edition.Id, edition.Title, existingJob.Id, "AlreadyQueued", null);
        }

        // Create new ingestion job for re-processing
        var job = new IngestionJob
        {
            Id = Guid.NewGuid(),
            EditionId = edition.Id,
            BookFileId = bookFile.Id,
            TargetLanguage = edition.Language,
            Status = JobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        db.IngestionJobs.Add(job);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Queued reprocessing job {JobId} for edition {EditionId} ({Title})",
            job.Id, edition.Id, edition.Title);

        return new ReprocessedEditionInfo(edition.Id, edition.Title, job.Id, "Queued", null);
    }
}
