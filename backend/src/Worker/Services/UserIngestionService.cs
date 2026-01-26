using System.Text.Json;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using HtmlAgilityPack;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Registry;

namespace Worker.Services;

public class UserIngestionService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IFileStorageService _storage;
    private readonly IExtractorRegistry _extractorRegistry;
    private readonly ILogger<UserIngestionService> _logger;

    public UserIngestionService(
        IDbContextFactory<AppDbContext> dbFactory,
        IFileStorageService storage,
        IExtractorRegistry extractorRegistry,
        ILogger<UserIngestionService> logger)
    {
        _dbFactory = dbFactory;
        _storage = storage;
        _extractorRegistry = extractorRegistry;
        _logger = logger;
    }

    public async Task<UserIngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.UserIngestionJobs
            .Where(j => j.Status == JobStatus.Queued)
            .OrderBy(j => j.CreatedAt)
            .FirstOrDefaultAsync(ct);
    }

    public async Task ProcessJobAsync(Guid jobId, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var job = await db.UserIngestionJobs
            .Include(j => j.UserBookFile)
            .Include(j => j.UserBook)
            .FirstOrDefaultAsync(j => j.Id == jobId, ct);

        if (job is null)
        {
            _logger.LogWarning("User job {JobId} not found", jobId);
            return;
        }

        _logger.LogInformation("Processing user book job {JobId} for book {BookId}", jobId, job.UserBookId);

        try
        {
            // Mark as processing
            job.Status = JobStatus.Processing;
            job.StartedAt = DateTimeOffset.UtcNow;
            job.AttemptCount++;
            await db.SaveChangesAsync(ct);

            // Get file path
            var filePath = _storage.GetFullPath(job.UserBookFile.StoragePath);
            if (!File.Exists(filePath))
                throw new FileNotFoundException($"User book file not found: {filePath}");

            await using var fileStream = File.OpenRead(filePath);
            var request = new ExtractionRequest
            {
                Content = fileStream,
                FileName = job.UserBookFile.OriginalFileName,
                ContentLength = fileStream.Length,
                Options = ExtractionOptions.Default
            };

            // Extract content
            var extractor = _extractorRegistry.Resolve(request);
            var result = await extractor.ExtractAsync(request, ct);

            job.SourceFormat = result.SourceFormat.ToString();

            if (result.Diagnostics.TextSource == TextSource.None)
            {
                var warning = result.Diagnostics.Warnings.FirstOrDefault()?.Message ?? "Unsupported format";
                throw new NotSupportedException(warning);
            }

            // Save cover if present
            if (result.Metadata.CoverImage is { Length: > 0 })
            {
                var ext = result.Metadata.CoverMimeType switch
                {
                    "image/png" => ".png",
                    "image/gif" => ".gif",
                    "image/webp" => ".webp",
                    _ => ".jpg"
                };

                using var coverStream = new MemoryStream(result.Metadata.CoverImage);
                var coverPath = await _storage.SaveUserFileAsync(
                    job.UserBook.UserId, job.UserBookId, $"cover{ext}", coverStream, ct);
                job.UserBook.CoverPath = coverPath;
            }

            // Save inline images and build path->id map
            var imageMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var image in result.Images.Where(i => !i.IsCover))
            {
                try
                {
                    var assetId = Guid.NewGuid();
                    var ext = GetExtensionFromMimeType(image.MimeType);
                    using var imageStream = new MemoryStream(image.Data);
                    var storagePath = await _storage.SaveUserFileAsync(
                        job.UserBook.UserId, job.UserBookId, $"assets/{assetId}{ext}", imageStream, ct);
                    imageMap[image.OriginalPath] = $"/api/me/books/{job.UserBookId}/assets/{assetId}";
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to save user book image {Path}", image.OriginalPath);
                }
            }

            // Delete existing chapters (re-ingestion)
            var existingChapters = await db.UserChapters
                .Where(c => c.UserBookId == job.UserBookId)
                .ToListAsync(ct);
            db.UserChapters.RemoveRange(existingChapters);

            // Create chapters
            foreach (var unit in result.Units)
            {
                var html = RewriteImageSrcs(unit.Html ?? string.Empty, imageMap);
                var chapter = new UserChapter
                {
                    Id = Guid.NewGuid(),
                    UserBookId = job.UserBookId,
                    ChapterNumber = unit.OrderIndex + 1,
                    Title = SanitizeText(unit.Title ?? $"Chapter {unit.OrderIndex + 1}"),
                    Html = SanitizeText(html),
                    PlainText = SanitizeText(unit.PlainText),
                    WordCount = unit.WordCount,
                    CreatedAt = DateTimeOffset.UtcNow
                };
                db.UserChapters.Add(chapter);
            }

            // Update book metadata
            if (string.IsNullOrEmpty(job.UserBook.Description) && !string.IsNullOrEmpty(result.Metadata.Description))
                job.UserBook.Description = result.Metadata.Description;

            // If title was auto-generated, update with extracted title
            if (!string.IsNullOrEmpty(result.Metadata.Title))
            {
                var originalFileName = Path.GetFileNameWithoutExtension(job.UserBookFile.OriginalFileName);
                if (job.UserBook.Title == originalFileName)
                    job.UserBook.Title = result.Metadata.Title;
            }

            // Store ToC
            if (result.Toc is { Count: > 0 })
            {
                job.UserBook.TocJson = JsonSerializer.Serialize(result.Toc, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    WriteIndented = false
                });
            }

            // Mark success
            job.UserBook.Status = UserBookStatus.Ready;
            job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;
            job.Status = JobStatus.Succeeded;
            job.UnitsCount = result.Units.Count;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Error = null;

            await db.SaveChangesAsync(ct);

            _logger.LogInformation("User book job {JobId} completed. {ChapterCount} chapters created.",
                jobId, result.Units.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "User book job {JobId} failed", jobId);

            job.Status = JobStatus.Failed;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Error = ex.Message;

            job.UserBook.Status = UserBookStatus.Failed;
            job.UserBook.ErrorMessage = ex.Message;
            job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;

            await db.SaveChangesAsync(CancellationToken.None);
        }
    }

    private static string RewriteImageSrcs(string html, Dictionary<string, string> imageMap)
    {
        if (string.IsNullOrEmpty(html) || imageMap.Count == 0)
            return html;

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");
        if (imgNodes == null)
            return html;

        foreach (var img in imgNodes)
        {
            var src = img.GetAttributeValue("src", "");
            if (string.IsNullOrEmpty(src))
                continue;

            var normalizedSrc = NormalizeImagePath(src);

            foreach (var (originalPath, newUrl) in imageMap)
            {
                var normalizedOriginal = NormalizeImagePath(originalPath);
                if (normalizedSrc.Equals(normalizedOriginal, StringComparison.OrdinalIgnoreCase) ||
                    normalizedSrc.EndsWith(normalizedOriginal, StringComparison.OrdinalIgnoreCase) ||
                    normalizedOriginal.EndsWith(normalizedSrc, StringComparison.OrdinalIgnoreCase))
                {
                    img.SetAttributeValue("src", newUrl);
                    break;
                }
            }
        }

        return doc.DocumentNode.InnerHtml;
    }

    private static string NormalizeImagePath(string path)
    {
        var result = path;
        while (result.StartsWith("../"))
            result = result[3..];
        while (result.StartsWith("./"))
            result = result[2..];
        result = result.TrimStart('/');
        return result;
    }

    private static string GetExtensionFromMimeType(string mimeType)
    {
        return mimeType switch
        {
            "image/png" => ".png",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            "image/svg+xml" => ".svg",
            _ => ".jpg"
        };
    }

    private static string SanitizeText(string? text)
        => text?.Replace("\0", "") ?? "";
}
