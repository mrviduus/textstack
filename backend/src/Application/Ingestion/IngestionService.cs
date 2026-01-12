using System.Text.Json;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;

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

public class IngestionService(IAppDbContext db, IFileStorageService storage)
{
    public async Task<IngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        return await db.IngestionJobs
            .Where(j => j.Status == JobStatus.Queued)
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

    public async Task ProcessParsedBookAsync(
        IngestionJob job, ParsedBook parsed, ExtractionSummary? summary, CancellationToken ct)
    {
        // Update edition metadata if empty
        if (string.IsNullOrEmpty(job.Edition.Description) && !string.IsNullOrEmpty(parsed.Description))
            job.Edition.Description = parsed.Description;

        // Note: parsed.Authors could be used to auto-create Author records in the future

        job.Edition.UpdatedAt = DateTimeOffset.UtcNow;

        // Delete existing chapters (re-ingestion)
        var existingChapters = await db.Chapters
            .Where(c => c.EditionId == job.EditionId)
            .ToListAsync(ct);
        db.Chapters.RemoveRange(existingChapters);

        // Create new chapters
        foreach (var ch in parsed.Chapters)
        {
            var chapterSlug = SlugGenerator.GenerateChapterSlug(ch.Title, ch.Order);
            var chapter = new Chapter
            {
                Id = Guid.NewGuid(),
                EditionId = job.EditionId,
                ChapterNumber = ch.Order,
                Slug = chapterSlug,
                Title = SanitizeText(ch.Title),
                Html = SanitizeText(ch.Html),
                PlainText = SanitizeText(ch.PlainText),
                WordCount = ch.WordCount,
                OriginalChapterNumber = ch.OriginalChapterNumber,
                PartNumber = ch.PartNumber,
                TotalParts = ch.TotalParts,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            db.Chapters.Add(chapter);
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
        // Keep diagnostics from previous attempt for reference
        // AttemptCount will be incremented when processing starts

        await db.SaveChangesAsync(ct);
    }

    // Remove NULL bytes that PostgreSQL rejects (common in PDF extraction)
    private static string SanitizeText(string? text)
        => text?.Replace("\0", "") ?? "";
}
