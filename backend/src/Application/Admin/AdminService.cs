using System.Security.Cryptography;
using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.Admin;
using Contracts.Common;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using OnlineLib.Search.Abstractions;
using OnlineLib.Search.Contracts;
using OnlineLib.Search.Enums;

namespace Application.Admin;

public record UploadBookRequest(
    Guid SiteId,
    string Title,
    string Language,
    string? Description,
    Guid? WorkId,
    Guid? SourceEditionId,
    string FileName,
    long FileSize,
    Stream FileStream,
    List<Guid>? AuthorIds = null,
    Guid? GenreId = null
);

public record UploadBookResult(Guid WorkId, Guid EditionId, Guid BookFileId, Guid JobId);

public record IngestionJobDto(
    Guid Id,
    Guid EditionId,
    string EditionTitle,
    string FileName,
    string Status,
    string? SourceFormat,
    int? UnitsCount,
    string? TextSource,
    string? ErrorMessage,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt
);

public record IngestionJobDetailDto(
    Guid Id,
    Guid EditionId,
    Guid BookFileId,
    string FileName,
    string TargetLanguage,
    JobStatus Status,
    int AttemptCount,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt,
    IngestionEditionDto Edition,
    IngestionDiagnosticsDto? Diagnostics
);

public record IngestionEditionDto(string Title, string Language, string Slug);

public record IngestionDiagnosticsDto(
    string? SourceFormat,
    int? UnitsCount,
    string? TextSource,
    double? Confidence,
    List<IngestionWarningDto>? Warnings
);

public record IngestionWarningDto(int Code, string Message);

public record IngestionJobsQuery(
    int Offset = 0,
    int Limit = 20,
    JobStatus? Status = null,
    string? Search = null
);

public record ChapterPreviewDto(int ChapterNumber, string Title, string Preview, int TotalLength);

public class AdminService(IAppDbContext db, IFileStorageService storage, ISearchIndexer searchIndexer)
{
    private static readonly string[] AllowedExtensions = [".epub", ".pdf", ".fb2", ".djvu"];
    private const long MaxFileSize = 100 * 1024 * 1024;

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
            .FirstOrDefaultAsync(w => w.SiteId == siteId && w.Slug == slug, ct);
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
            ".fb2" => BookFormat.Fb2,
            ".djvu" => BookFormat.Djvu,
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

        var storagePath = await storage.SaveFileAsync(edition.Id, req.FileName, req.FileStream, ct);

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
        // Keep diagnostics from previous attempt for reference
        // AttemptCount will be incremented when processing starts

        await db.SaveChangesAsync(ct);

        var dto = await GetIngestionJobAsync(id, ct);
        return (true, null, dto);
    }

    private async Task<string> GenerateUniqueEditionSlugAsync(
        Guid siteId, string title, string language, CancellationToken ct)
    {
        var baseSlug = SlugGenerator.GenerateSlug(title);
        var slug = baseSlug;
        var exists = await db.Editions.AnyAsync(e => e.SiteId == siteId && e.Language == language && e.Slug == slug, ct);

        if (exists)
        {
            slug = $"{baseSlug}-{language}";
            exists = await db.Editions.AnyAsync(e => e.SiteId == siteId && e.Language == language && e.Slug == slug, ct);
        }

        var counter = 2;
        while (exists)
        {
            slug = $"{baseSlug}-{language}-{counter}";
            exists = await db.Editions.AnyAsync(e => e.SiteId == siteId && e.Language == language && e.Slug == slug, ct);
            counter++;
        }

        return slug;
    }

    // Edition CRUD

    public async Task<AdminStatsDto> GetStatsAsync(Guid? siteId, CancellationToken ct)
    {
        var editionQuery = db.Editions.AsQueryable();
        var authorQuery = db.Authors.AsQueryable();
        var chapterQuery = db.Chapters.AsQueryable();

        if (siteId.HasValue)
        {
            editionQuery = editionQuery.Where(e => e.SiteId == siteId.Value);
            authorQuery = authorQuery.Where(a => a.SiteId == siteId.Value);
            chapterQuery = chapterQuery.Where(c => c.Edition.SiteId == siteId.Value);
        }

        var totalEditions = await editionQuery.CountAsync(ct);
        var publishedEditions = await editionQuery.Where(e => e.Status == EditionStatus.Published).CountAsync(ct);
        var draftEditions = await editionQuery.Where(e => e.Status == EditionStatus.Draft).CountAsync(ct);
        var totalChapters = await chapterQuery.CountAsync(ct);
        var totalAuthors = await authorQuery.CountAsync(ct);

        return new AdminStatsDto(
            TotalEditions: totalEditions,
            PublishedEditions: publishedEditions,
            DraftEditions: draftEditions,
            TotalChapters: totalChapters,
            TotalAuthors: totalAuthors
        );
    }

    public async Task<PaginatedResult<AdminEditionListDto>> GetEditionsAsync(
        Guid? siteId, int offset, int limit, EditionStatus? status, string? search, string? language, bool? indexable, CancellationToken ct)
    {
        var query = db.Editions.AsQueryable();

        if (siteId.HasValue)
            query = query.Where(e => e.SiteId == siteId.Value);

        if (status.HasValue)
            query = query.Where(e => e.Status == status.Value);

        if (!string.IsNullOrWhiteSpace(search))
            query = query.Where(e => e.Title.Contains(search) || e.EditionAuthors.Any(ea => ea.Author.Name.Contains(search)));

        if (!string.IsNullOrWhiteSpace(language))
            query = query.Where(e => e.Language == language);

        if (indexable.HasValue)
        {
            if (indexable.Value)
                // "Indexed" = indexable AND published
                query = query.Where(e => e.Indexable && e.Status == EditionStatus.Published);
            else
                // "Not indexed" = not indexable OR not published
                query = query.Where(e => !e.Indexable || e.Status != EditionStatus.Published);
        }

        var total = await query.CountAsync(ct);

        var items = await query
            .OrderByDescending(e => e.CreatedAt)
            .Skip(offset)
            .Take(limit)
            .Select(e => new AdminEditionListDto(
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                e.Status.ToString(),
                e.Chapters.Count,
                e.CreatedAt,
                e.PublishedAt,
                string.Join(", ", e.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name))
            ))
            .ToListAsync(ct);

        return new PaginatedResult<AdminEditionListDto>(total, items);
    }

    public async Task<AdminEditionDetailDto?> GetEditionDetailAsync(Guid id, CancellationToken ct)
    {
        return await db.Editions
            .Where(e => e.Id == id)
            .Select(e => new AdminEditionDetailDto(
                e.Id,
                e.WorkId,
                e.SiteId,
                e.Slug,
                e.Title,
                e.Language,
                e.Description,
                e.CoverPath,
                e.Status.ToString(),
                e.IsPublicDomain,
                e.CreatedAt,
                e.PublishedAt,
                e.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new AdminChapterDto(c.Id, c.ChapterNumber, c.Slug, c.Title, c.WordCount))
                    .ToList(),
                e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new AdminEditionAuthorDto(ea.AuthorId, ea.Author.Slug, ea.Author.Name, ea.Order, ea.Role.ToString()))
                    .ToList(),
                e.Genres
                    .OrderBy(g => g.Name)
                    .Select(g => new AdminEditionGenreDto(g.Id, g.Slug, g.Name))
                    .ToList(),
                e.Indexable,
                e.SeoTitle,
                e.SeoDescription,
                e.CanonicalOverride
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(bool Success, string? Error)> UpdateEditionAsync(
        Guid id, UpdateEditionRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return (false, "Title is required");

        if (request.Title.Length > 500)
            return (false, "Title must be 500 characters or less");

        if (request.Description?.Length > 5000)
            return (false, "Description must be 5000 characters or less");

        var edition = await db.Editions.FindAsync([id], ct);
        if (edition is null)
            return (false, "Edition not found");

        edition.Title = request.Title;
        edition.Description = request.Description;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        // SEO fields
        if (request.Indexable.HasValue)
            edition.Indexable = request.Indexable.Value;
        edition.SeoTitle = request.SeoTitle;
        edition.SeoDescription = request.SeoDescription;
        edition.CanonicalOverride = request.CanonicalOverride;

        // Handle author assignment
        if (request.Authors is not null)
        {
            // Remove existing author associations
            var existingAuthors = await db.EditionAuthors
                .Where(ea => ea.EditionId == id)
                .ToListAsync(ct);
            db.EditionAuthors.RemoveRange(existingAuthors);

            // Add new author associations with order
            for (var i = 0; i < request.Authors.Count; i++)
            {
                var authorDto = request.Authors[i];
                var role = Enum.TryParse<AuthorRole>(authorDto.Role, true, out var parsedRole)
                    ? parsedRole
                    : AuthorRole.Author;

                db.EditionAuthors.Add(new EditionAuthor
                {
                    EditionId = id,
                    AuthorId = authorDto.AuthorId,
                    Order = i,
                    Role = role
                });
            }
        }

        // Handle genre assignment
        if (request.GenreIds is not null)
        {
            // Load edition with genres for M2M update
            var editionWithGenres = await db.Editions
                .Include(e => e.Genres)
                .FirstAsync(e => e.Id == id, ct);

            // Clear existing genres
            editionWithGenres.Genres.Clear();

            // Add new genres
            if (request.GenreIds.Count > 0)
            {
                var genres = await db.Genres
                    .Where(g => request.GenreIds.Contains(g.Id) && g.SiteId == edition.SiteId)
                    .ToListAsync(ct);

                foreach (var genre in genres)
                {
                    editionWithGenres.Genres.Add(genre);
                }
            }
        }

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> DeleteEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions
            .Include(e => e.Chapters)
            .Include(e => e.BookFiles)
            .FirstOrDefaultAsync(e => e.Id == id, ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status == EditionStatus.Published)
            return (false, "Cannot delete published edition. Unpublish first.");

        // Delete related entities
        db.Chapters.RemoveRange(edition.Chapters);
        db.BookFiles.RemoveRange(edition.BookFiles);

        // Delete ingestion jobs
        var jobs = await db.IngestionJobs.Where(j => j.EditionId == id).ToListAsync(ct);
        db.IngestionJobs.RemoveRange(jobs);

        db.Editions.Remove(edition);

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> PublishEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions
            .Include(e => e.Chapters)
            .Include(e => e.EditionAuthors)
                .ThenInclude(ea => ea.Author)
            .FirstOrDefaultAsync(e => e.Id == id, ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status == EditionStatus.Published)
            return (false, "Edition is already published");

        if (edition.Chapters.Count == 0)
            return (false, "Cannot publish edition with no chapters");

        edition.Status = EditionStatus.Published;
        edition.PublishedAt = DateTimeOffset.UtcNow;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        // Index chapters for search
        await IndexChaptersAsync(edition, ct);

        return (true, null);
    }

    private async Task IndexChaptersAsync(Edition edition, CancellationToken ct)
    {
        var searchLang = edition.Language switch
        {
            "uk" => SearchLanguage.Uk,
            "en" => SearchLanguage.En,
            _ => SearchLanguage.Auto
        };

        var authors = string.Join(", ", edition.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name));

        var documents = edition.Chapters.Select(chapter => new IndexDocument(
            Id: chapter.Id.ToString(),
            Title: chapter.Title,
            Content: chapter.PlainText,
            Language: searchLang,
            SiteId: edition.SiteId,
            Metadata: new Dictionary<string, object>
            {
                ["chapterId"] = chapter.Id,
                ["chapterSlug"] = chapter.Slug ?? string.Empty,
                ["chapterTitle"] = chapter.Title,
                ["chapterNumber"] = chapter.ChapterNumber,
                ["editionId"] = edition.Id,
                ["editionSlug"] = edition.Slug,
                ["editionTitle"] = edition.Title,
                ["language"] = edition.Language,
                ["authors"] = authors,
                ["coverPath"] = edition.CoverPath ?? string.Empty
            }
        )).ToList();

        if (documents.Count > 0)
        {
            await searchIndexer.IndexBatchAsync(documents, ct);
        }
    }

    public async Task<(bool Success, string? Error)> UnpublishEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions.FindAsync([id], ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status != EditionStatus.Published)
            return (false, "Edition is not published");

        edition.Status = EditionStatus.Draft;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    // Chapter CRUD

    public async Task<AdminChapterDetailDto?> GetChapterDetailAsync(Guid id, CancellationToken ct)
    {
        return await db.Chapters
            .Where(c => c.Id == id)
            .Select(c => new AdminChapterDetailDto(
                c.Id,
                c.EditionId,
                c.ChapterNumber,
                c.Slug,
                c.Title,
                c.Html,
                c.WordCount,
                c.CreatedAt,
                c.UpdatedAt
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(bool Success, string? Error)> UpdateChapterAsync(
        Guid id, UpdateChapterRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return (false, "Title is required");

        if (string.IsNullOrWhiteSpace(request.Html))
            return (false, "Content is required");

        var chapter = await db.Chapters.FindAsync([id], ct);
        if (chapter is null)
            return (false, "Chapter not found");

        chapter.Title = request.Title;
        chapter.Html = request.Html;
        chapter.PlainText = StripHtml(request.Html);
        chapter.WordCount = CountWords(chapter.PlainText);
        chapter.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> DeleteChapterAsync(Guid id, CancellationToken ct)
    {
        var chapter = await db.Chapters.FindAsync([id], ct);
        if (chapter is null)
            return (false, "Chapter not found");

        var editionId = chapter.EditionId;
        var deletedNumber = chapter.ChapterNumber;

        db.Chapters.Remove(chapter);

        // Renumber remaining chapters
        var remaining = await db.Chapters
            .Where(c => c.EditionId == editionId && c.ChapterNumber > deletedNumber)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        foreach (var ch in remaining)
        {
            ch.ChapterNumber--;
            ch.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    private static string StripHtml(string html)
    {
        if (string.IsNullOrEmpty(html))
            return string.Empty;

        // Simple regex-based HTML stripping
        var text = System.Text.RegularExpressions.Regex.Replace(html, "<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ");
        return text.Trim();
    }

    private static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return 0;
        return text.Split([' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
