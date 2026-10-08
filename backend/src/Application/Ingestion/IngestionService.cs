using System.Text.Json;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TextStack.Extraction.Quality;
using static TextStack.Extraction.Utilities.TextProcessingUtils;

namespace Application.Ingestion;

public record ParsedChapter(
    int Order,
    string Title,
    string Html,
    string PlainText,
    int WordCount,
    int? OriginalChapterNumber = null,
    int? PartNumber = null,
    int? TotalParts = null
);
public record ParsedBook(string? Title, string? Authors, string? Description, List<ParsedChapter> Chapters);

public record ExtractionSummary(
    string SourceFormat,
    int UnitsCount,
    string TextSource,
    double? Confidence,
    List<ExtractionWarningDto> Warnings
);

public record ExtractionWarningDto(int Code, string Message);

public class IngestionService(
    IAppDbContext db, IFileStorageService storage, ILogger<IngestionService> logger)
{
    private static readonly TimeSpan StuckJobTimeout = TimeSpan.FromMinutes(10);
    public const int MaxAttempts = 3;
    public const string ExceededAttemptsError = "Exceeded max retry attempts (worker crashed or timed out on every attempt)";

    public async Task<IngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        var stuckThreshold = DateTimeOffset.UtcNow - StuckJobTimeout;

        // A job stuck in Processing after its last attempt crashed the worker every time it ran.
        // The pick-up filter below skips it, so without this it would sit there forever; end it
        // Failed instead (the admin retry resets the count). Same for a job Queued at the cap — a
        // legacy row re-queued before retries reset the count — which only Failed makes retryable.
        var exhausted = await db.IngestionJobs
            .Where(j => j.AttemptCount >= MaxAttempts &&
                        (j.Status == JobStatus.Queued ||
                         (j.Status == JobStatus.Processing && j.StartedAt < stuckThreshold)))
            .ToListAsync(ct);
        if (exhausted.Count > 0)
        {
            foreach (var job in exhausted)
            {
                job.Status = JobStatus.Failed;
                job.FinishedAt = DateTimeOffset.UtcNow;
                job.Error = ExceededAttemptsError;
                logger.LogWarning("Ingestion job {JobId} exceeded {Max} attempts, marked failed", job.Id, MaxAttempts);
            }
            await db.SaveChangesAsync(ct);
        }

        // Pick up queued jobs or stuck InProgress jobs (crashed worker)
        return await db.IngestionJobs
            .Where(j => j.AttemptCount < MaxAttempts &&
                        (j.Status == JobStatus.Queued ||
                         (j.Status == JobStatus.Processing && j.StartedAt < stuckThreshold)))
            .OrderBy(j => j.CreatedAt)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<IngestionJob?> GetJobWithDetailsAsync(Guid jobId, CancellationToken ct)
    {
        return await db.IngestionJobs
            .Include(j => j.BookFile)
            .Include(j => j.Edition)
                .ThenInclude(e => e.Site)
            .FirstOrDefaultAsync(j => j.Id == jobId, ct);
    }

    public string GetFilePath(string storagePath) => storage.GetFullPath(storagePath);

    public async Task MarkJobProcessingAsync(IngestionJob job, CancellationToken ct)
    {
        job.Status = JobStatus.Processing;
        job.StartedAt = DateTimeOffset.UtcNow;
        job.AttemptCount++;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// ADR-022: a graceful shutdown gives the claim back — <see cref="JobStatus.Queued"/>, the attempt
    /// the claim counted returned, no error. Matches only the row as this run claimed it (Processing at
    /// <paramref name="claimedAttempt"/>): a claim that never committed, or a job that already finished,
    /// is left alone, so a crashed attempt is never un-counted. Set-based, so nothing half-done from the
    /// cancelled run is flushed with it; never cancellable, because the stopping token already fired.
    /// </summary>
    public static Task<int> ReturnToQueueAsync(IQueryable<IngestionJob> jobs, Guid jobId, int claimedAttempt) =>
        jobs.Where(j => j.Id == jobId && j.Status == JobStatus.Processing && j.AttemptCount == claimedAttempt)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, JobStatus.Queued)
                .SetProperty(j => j.AttemptCount, claimedAttempt - 1)
                .SetProperty(j => j.StartedAt, (DateTimeOffset?)null), CancellationToken.None);

    public async Task ProcessParsedBookAsync(
        IngestionJob job, ParsedBook parsed, ExtractionSummary? summary, string? tocJson, CancellationToken ct)
    {
        // Chapters first and in place (ChapterReconciler): readers' progress, bookmarks and
        // highlights point at chapter Ids, which re-ingestion used to regenerate.
        var qualityScores = new List<int>();
        var chapters = new List<Chapter>();
        foreach (var ch in parsed.Chapters)
        {
            var chapterSlug = SlugGenerator.GenerateChapterSlug(ch.Title, ch.Order);
            var chapterHtml = SanitizeText(ch.Html);
            var score = ChapterContentQualityAnalyzer.Analyze(chapterHtml).Score;
            qualityScores.Add(score);
            chapters.Add(new Chapter
            {
                Id = Guid.NewGuid(),
                EditionId = job.EditionId,
                ChapterNumber = ch.Order,
                Slug = chapterSlug,
                Title = SanitizeText(ch.Title),
                Html = chapterHtml,
                PlainText = SanitizeText(ch.PlainText),
                WordCount = ch.WordCount,
                ContentQualityScore = score,
                OriginalChapterNumber = ch.OriginalChapterNumber,
                PartNumber = ch.PartNumber,
                TotalParts = ch.TotalParts,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            });
        }
        await ChapterReconciler.ReconcileEditionAsync(db, job.EditionId, chapters, ct, logger);

        // Update edition metadata if empty
        if (string.IsNullOrEmpty(job.Edition.Description) && !string.IsNullOrEmpty(parsed.Description))
            job.Edition.Description = parsed.Description;

        // Note: parsed.Authors could be used to auto-create Author records in the future

        // Store table of contents
        if (!string.IsNullOrEmpty(tocJson))
            job.Edition.TocJson = tocJson;

        job.Edition.UpdatedAt = DateTimeOffset.UtcNow;

        if (qualityScores.Count > 0)
        {
            logger.LogInformation(
                "Content quality for edition {EditionId}: {Count} chapters, avg score {Avg}, {Below} below 60",
                job.EditionId, qualityScores.Count, (int)qualityScores.Average(),
                qualityScores.Count(s => s < 60));
        }

        // Publish the edition
        job.Edition.Status = EditionStatus.Published;
        job.Edition.PublishedAt = DateTimeOffset.UtcNow;

        // Persist extraction summary
        if (summary is not null)
        {
            job.SourceFormat = summary.SourceFormat;
            job.UnitsCount = summary.UnitsCount;
            job.TextSource = summary.TextSource;
            job.Confidence = summary.Confidence;
            job.WarningsJson = summary.Warnings.Count > 0
                ? JsonSerializer.Serialize(summary.Warnings)
                : null;
        }

        // Mark job as succeeded
        job.Status = JobStatus.Succeeded;
        job.FinishedAt = DateTimeOffset.UtcNow;
        job.Error = null;

        await db.SaveChangesAsync(ct);
    }

    public async Task MarkJobFailedAsync(
        IngestionJob job, string error, ExtractionSummary? summary, CancellationToken ct)
    {
        job.Status = JobStatus.Failed;
        job.FinishedAt = DateTimeOffset.UtcNow;
        job.Error = error;

        // Persist extraction summary even on failure (for diagnostics)
        if (summary is not null)
        {
            job.SourceFormat = summary.SourceFormat;
            job.UnitsCount = summary.UnitsCount;
            job.TextSource = summary.TextSource;
            job.Confidence = summary.Confidence;
            job.WarningsJson = summary.Warnings.Count > 0
                ? JsonSerializer.Serialize(summary.Warnings)
                : null;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task ResetJobForRetryAsync(IngestionJob job, CancellationToken ct)
    {
        // Only allow retry for failed jobs
        if (job.Status != JobStatus.Failed)
            return;

        job.Status = JobStatus.Queued;
        job.Error = null;
        job.StartedAt = null;
        job.FinishedAt = null;
        // A manual retry gets a fresh attempt budget; GetNextJobAsync skips jobs at MaxAttempts.
        job.AttemptCount = 0;
        // Keep diagnostics from previous attempt for reference

        await db.SaveChangesAsync(ct);
    }
}
