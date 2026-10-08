using System.Security.Cryptography;
using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.Admin;
using Contracts.Common;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using Application.UserBooks;

namespace Application.Admin;

/// <summary>
/// Upload + ingestion-job management — file validation, work/edition creation, book upload, ingestion job listing/detail/preview/retry, and slug generation. Extracted from the monolithic AdminService.cs.
/// </summary>
public partial class AdminService
{
    public async Task<(bool Valid, string? Error)> ValidateUploadAsync(
        Guid siteId, string fileName, long fileSize, CancellationToken ct)
    {
        if (!await db.Sites.AnyAsync(s => s.Id == siteId, ct))
            return (false, "Invalid siteId");

        if (fileSize == 0)
            return (false, "File is empty");

        if (fileSize > MaxFileSize)
            return (false, $"File too large. Max {MaxFileSize / 1024 / 1024}MB");

        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (!AllowedExtensions.Contains(ext))
            return (false, $"Invalid file type. Allowed: {string.Join(", ", AllowedExtensions)}");

        return (true, null);
    }

    public async Task<(bool Valid, string? Error, Work? Work)> GetOrCreateWorkAsync(
        Guid siteId, string title, Guid? workId, CancellationToken ct)
    {
        if (workId.HasValue)
        {
            var work = await db.Works.FindAsync([workId.Value], ct);
            if (work is null)
                return (false, "Work not found", null);
            if (work.SiteId != siteId)
                return (false, "Work belongs to different site", null);
            return (true, null, work);
        }

        var slug = SlugGenerator.GenerateSlug(title);
        var existingWork = await db.Works
            .FirstOrDefaultAsync(w => w.Slug == slug, ct);
        if (existingWork is not null)
            return (true, null, existingWork);

        var newWork = new Work
        {
            Id = Guid.NewGuid(),
            SiteId = siteId,
            Slug = slug,
            CreatedAt = DateTimeOffset.UtcNow
        };
        db.Works.Add(newWork);
        return (true, null, newWork);
    }

    public async Task<UploadBookResult> UploadBookAsync(UploadBookRequest req, Work work, CancellationToken ct)
    {
        var ext = Path.GetExtension(req.FileName).ToLowerInvariant();
        var format = ext switch
        {
            ".epub" => BookFormat.Epub,
            ".pdf" => BookFormat.Pdf,
            _ => BookFormat.Other
        };

        var editionSlug = await GenerateUniqueEditionSlugAsync(req.SiteId, req.Title, req.Language, ct);
        var edition = new Edition
        {
            Id = Guid.NewGuid(),
            WorkId = work.Id,
            SiteId = req.SiteId,
            Language = req.Language,
            Slug = editionSlug,
            Title = req.Title,
            Description = req.Description,
            Status = EditionStatus.Draft,
            SourceEditionId = req.SourceEditionId,
            IsPublicDomain = false,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        db.Editions.Add(edition);

        // Add authors if provided
        if (req.AuthorIds is { Count: > 0 })
        {
            var order = 0;
            foreach (var authorId in req.AuthorIds)
            {
                db.EditionAuthors.Add(new EditionAuthor
                {
                    EditionId = edition.Id,
                    AuthorId = authorId,
                    Order = order++,
                    Role = AuthorRole.Author
                });
            }
        }

        // Add genre if provided (M2M via edition_genres)
        if (req.GenreId.HasValue)
        {
            var genre = await db.Genres.FindAsync([req.GenreId.Value], ct);
            if (genre is not null)
            {
                edition.Genres.Add(genre);
            }
        }

        // The client's file name is display data: keep only its last segment for the stored copy.
        var storagePath = await storage.SaveFileAsync(edition.Id, Path.GetFileName(req.FileName), req.FileStream, ct);

        req.FileStream.Position = 0;
        using var sha = SHA256.Create();
        var hashBytes = await sha.ComputeHashAsync(req.FileStream, ct);
        var hash = Convert.ToHexString(hashBytes).ToLowerInvariant();

        var bookFile = new BookFile
        {
            Id = Guid.NewGuid(),
            EditionId = edition.Id,
            OriginalFileName = req.FileName,
            StoragePath = storagePath,
            Format = format,
            Sha256 = hash,
            UploadedAt = DateTimeOffset.UtcNow
        };
        db.BookFiles.Add(bookFile);

        var job = new IngestionJob
        {
            Id = Guid.NewGuid(),
            EditionId = edition.Id,
            BookFileId = bookFile.Id,
            TargetLanguage = req.Language,
            WorkId = req.WorkId,
            SourceEditionId = req.SourceEditionId,
            Status = JobStatus.Queued,
            AttemptCount = 0,
            CreatedAt = DateTimeOffset.UtcNow
        };
        db.IngestionJobs.Add(job);

        await db.SaveChangesAsync(ct);

        return new UploadBookResult(work.Id, edition.Id, bookFile.Id, job.Id);
    }

    public async Task<List<IngestionJobDto>> GetIngestionJobsAsync(
        IngestionJobsQuery query, CancellationToken ct)
    {
        var q = db.IngestionJobs
            .Include(j => j.Edition)
            .Include(j => j.BookFile)
            .AsQueryable();

        if (query.Status.HasValue)
            q = q.Where(j => j.Status == query.Status.Value);

        if (!string.IsNullOrWhiteSpace(query.Search))
            q = q.Where(j => j.Edition.Title.Contains(query.Search) ||
                             j.BookFile.OriginalFileName.Contains(query.Search));

        return await q
            .OrderByDescending(j => j.CreatedAt)
            .Skip(query.Offset)
            .Take(query.Limit)
            .Select(j => new IngestionJobDto(
                j.Id,
                j.EditionId,
                j.Edition.Title,
                j.BookFile.OriginalFileName,
                j.Status.ToString(),
                j.SourceFormat,
                j.UnitsCount,
                j.TextSource,
                j.Error,
                j.CreatedAt,
                j.StartedAt,
                j.FinishedAt
            ))
            .ToListAsync(ct);
    }

    public async Task<IngestionJobDetailDto?> GetIngestionJobAsync(Guid id, CancellationToken ct)
    {
        var job = await db.IngestionJobs
            .Include(j => j.Edition)
            .Include(j => j.BookFile)
            .FirstOrDefaultAsync(j => j.Id == id, ct);

        if (job is null)
            return null;

        List<IngestionWarningDto>? warnings = null;
        if (!string.IsNullOrEmpty(job.WarningsJson))
        {
            try
            {
                warnings = JsonSerializer.Deserialize<List<IngestionWarningDto>>(job.WarningsJson);
            }
            catch
            {
                // Ignore deserialization errors
            }
        }

        var diagnostics = job.SourceFormat is not null
            ? new IngestionDiagnosticsDto(
                job.SourceFormat,
                job.UnitsCount,
                job.TextSource,
                job.Confidence,
                warnings)
            : null;

        return new IngestionJobDetailDto(
            job.Id,
            job.EditionId,
            job.BookFileId,
            job.BookFile.OriginalFileName,
            job.TargetLanguage,
            job.Status,
            job.AttemptCount,
            job.Error,
            job.CreatedAt,
            job.StartedAt,
            job.FinishedAt,
            new IngestionEditionDto(job.Edition.Title, job.Edition.Language, job.Edition.Slug),
            diagnostics
        );
    }

    public async Task<ChapterPreviewDto?> GetChapterPreviewAsync(
        Guid jobId, int chapterIndex, int maxChars, CancellationToken ct)
    {
        maxChars = Math.Min(maxChars, 10000); // Enforce max limit

        var job = await db.IngestionJobs
            .FirstOrDefaultAsync(j => j.Id == jobId, ct);

        if (job is null)
            return null;

        var chapter = await db.Chapters
            .Where(c => c.EditionId == job.EditionId)
            .OrderBy(c => c.ChapterNumber)
            .Skip(chapterIndex)
            .FirstOrDefaultAsync(ct);

        if (chapter is null)
            return null;

        var preview = chapter.PlainText.Length <= maxChars
            ? chapter.PlainText
            : chapter.PlainText[..maxChars] + "...";

        return new ChapterPreviewDto(
            chapter.ChapterNumber,
            chapter.Title,
            preview,
            chapter.PlainText.Length
        );
    }

    public async Task<(bool Success, string? Error, IngestionJobDetailDto? Job)> RetryJobAsync(
        Guid id, CancellationToken ct)
    {
        var job = await db.IngestionJobs
            .Include(j => j.Edition)
            .Include(j => j.BookFile)
            .FirstOrDefaultAsync(j => j.Id == id, ct);

        if (job is null)
            return (false, "Job not found", null);

        // Idempotency: if already queued or processing, just return current state
        if (job.Status == JobStatus.Queued || job.Status == JobStatus.Processing)
        {
            var currentDto = await GetIngestionJobAsync(id, ct);
            return (true, null, currentDto);
        }

        // Only allow retry for failed jobs
        if (job.Status != JobStatus.Failed)
            return (false, "Can only retry failed jobs", null);

        // Reset job for retry
        job.Status = JobStatus.Queued;
        job.Error = null;
        job.StartedAt = null;
        job.FinishedAt = null;
        // A manual retry gets a fresh attempt budget; IngestionService.GetNextJobAsync skips jobs at MaxAttempts.
        job.AttemptCount = 0;
        // Keep diagnostics from previous attempt for reference

        await db.SaveChangesAsync(ct);

        var dto = await GetIngestionJobAsync(id, ct);
        return (true, null, dto);
    }

    private async Task<string> GenerateUniqueEditionSlugAsync(
        Guid siteId, string title, string language, CancellationToken ct)
    {
        var baseSlug = SlugGenerator.GenerateSlug(title);
        var slug = baseSlug;
        var exists = await db.Editions.AnyAsync(e => e.Language == language && e.Slug == slug, ct);

        if (exists)
        {
            slug = $"{baseSlug}-{language}";
            exists = await db.Editions.AnyAsync(e => e.Language == language && e.Slug == slug, ct);
        }

        var counter = 2;
        while (exists)
        {
            slug = $"{baseSlug}-{language}-{counter}";
            exists = await db.Editions.AnyAsync(e => e.Language == language && e.Slug == slug, ct);
            counter++;
        }

        return slug;
    }
}
