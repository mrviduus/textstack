using System.Text.Json;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Quality;
using TextStack.Extraction.Registry;
using static TextStack.Extraction.Utilities.HtmlCleaner;
using static TextStack.Extraction.Utilities.TextProcessingUtils;

namespace Worker.Services;

public class UserIngestionService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IFileStorageService _storage;
    private readonly IExtractorRegistry _extractorRegistry;
    private readonly IImageOptimizer _imageOptimizer;
    private readonly UserBookEnrichmentService _enrichmentService;
    private readonly ITagSuggestionGenerator _tagGenerator;
    private readonly ILogger<UserIngestionService> _logger;

    public UserIngestionService(
        IDbContextFactory<AppDbContext> dbFactory,
        IFileStorageService storage,
        IExtractorRegistry extractorRegistry,
        IImageOptimizer imageOptimizer,
        UserBookEnrichmentService enrichmentService,
        ITagSuggestionGenerator tagGenerator,
        ILogger<UserIngestionService> logger)
    {
        _dbFactory = dbFactory;
        _storage = storage;
        _extractorRegistry = extractorRegistry;
        _imageOptimizer = imageOptimizer;
        _enrichmentService = enrichmentService;
        _tagGenerator = tagGenerator;
        _logger = logger;
    }

    private static readonly TimeSpan StuckJobTimeout = TimeSpan.FromMinutes(2);
    private const int MaxAttempts = 3;

    public async Task<UserIngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var stuckThreshold = DateTimeOffset.UtcNow - StuckJobTimeout;

        // Pick up queued jobs or stuck InProgress jobs (crashed worker)
        return await db.UserIngestionJobs
            .Where(j => j.AttemptCount < MaxAttempts &&
                        (j.Status == JobStatus.Queued ||
                         (j.Status == JobStatus.Processing && j.StartedAt < stuckThreshold)))
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

        // Safety net: GetNextJobAsync already filters AttemptCount < MaxAttempts,
        // but guard here in case of race conditions or direct calls
        if (job.AttemptCount >= MaxAttempts)
        {
            _logger.LogWarning("User book job {JobId} exceeded max attempts ({Max}), marking failed", jobId, MaxAttempts);
            job.Status = JobStatus.Failed;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Error = "Exceeded max retry attempts";
            job.UserBook.Status = UserBookStatus.Failed;
            job.UserBook.ErrorMessage = "Processing failed after multiple attempts. Try re-uploading or use a different file.";
            job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return;
        }

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
                // User PDFs render pixel-perfect via PDF.js + vision RAG, so drop
                // extracted inline images (ADR-012 S5a). Explicit for readable intent.
                Options = new ExtractionOptions { ExtractInlineImages = false }
            };

            // Extract content
            var extractor = _extractorRegistry.Resolve(request);
            var result = await extractor.ExtractAsync(request, ct);

            job.SourceFormat = result.SourceFormat.ToString();

            if (result.Diagnostics.TextSource == TextSource.None)
            {
                var warning = result.Diagnostics.Warnings.FirstOrDefault();
                var technicalMsg = warning?.Message ?? "Unsupported format";
                var friendlyMsg = MapToFriendlyError(warning?.Code);

                job.Status = JobStatus.Failed;
                job.FinishedAt = DateTimeOffset.UtcNow;
                job.Error = technicalMsg;
                job.UserBook.Status = UserBookStatus.Failed;
                job.UserBook.ErrorMessage = friendlyMsg;
                job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
                return;
            }

            if (result.Units.Count == 0)
            {
                job.Status = JobStatus.Failed;
                job.FinishedAt = DateTimeOffset.UtcNow;
                job.Error = "No readable content extracted";
                job.UserBook.Status = UserBookStatus.Failed;
                job.UserBook.ErrorMessage = "Could not extract any readable content from this file.";
                job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
                return;
            }

            // Save cover
            if (result.Metadata.CoverImage is { Length: > 0 })
            {
                var coverMime = result.Metadata.CoverMimeType ?? "image/jpeg";
                var optimizedCover = await _imageOptimizer.OptimizeAsync(
                    result.Metadata.CoverImage, coverMime, ct: ct);
                var ext = optimizedCover.Extension;

                using var coverStream = new MemoryStream(optimizedCover.Data);
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
                    var optimized = await _imageOptimizer.OptimizeAsync(image.Data, image.MimeType, ct: ct);
                    var ext = optimized.Extension;
                    using var imageStream = new MemoryStream(optimized.Data);
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

            // Create chapters. Number saved chapters densely 1..N by their position
            // in THIS loop, not by unit.OrderIndex — the extractor skips units
            // (empty content, piracy watermarks, the spine's navigation document),
            // so OrderIndex has gaps. The running counter feeds both ChapterNumber
            // and the slug's order arg so slugs stay consistent with numbering.
            //
            // This comment used to claim TOC and front matter were "filtered out".
            // Only the navigation document is, and only since the extractor learned
            // to recognise it — before that a user's uploaded EPUB opened on its
            // own table of contents.
            var qualityScores = new List<int>();
            var savedChapterIndex = 0;
            foreach (var unit in result.Units)
            {
                var html = SanitizeText(
                    Application.Common.ImageProcessingHelper.RewriteImageSrcs(unit.Html ?? string.Empty, imageMap));
                var chapterTitle = SanitizeText(unit.Title ?? $"Chapter {savedChapterIndex + 1}");
                var score = ChapterContentQualityAnalyzer.Analyze(html).Score;
                qualityScores.Add(score);
                var chapter = new UserChapter
                {
                    Id = Guid.NewGuid(),
                    UserBookId = job.UserBookId,
                    ChapterNumber = savedChapterIndex + 1,
                    Slug = SlugGenerator.GenerateChapterSlug(chapterTitle, savedChapterIndex),
                    Title = chapterTitle,
                    Html = html,
                    PlainText = SanitizeText(unit.PlainText),
                    WordCount = unit.WordCount,
                    ContentQualityScore = score,
                    // Physical PDF page range (null for EPUB/HTML) for the "Original layout" reader jump.
                    SourceStartPage = unit.SourceStartPage,
                    SourceEndPage = unit.SourceEndPage,
                    CreatedAt = DateTimeOffset.UtcNow
                };
                db.UserChapters.Add(chapter);
                savedChapterIndex++;
            }

            if (qualityScores.Count > 0)
            {
                _logger.LogInformation(
                    "Content quality for user book {BookId}: {Count} chapters, avg score {Avg}, {Below} below 60",
                    job.UserBookId, qualityScores.Count, (int)qualityScores.Average(),
                    qualityScores.Count(s => s < 60));
            }

            // Update book metadata
            if (string.IsNullOrEmpty(job.UserBook.Description) && !string.IsNullOrEmpty(result.Metadata.Description))
                job.UserBook.Description = StripHtml(result.Metadata.Description);

            if (string.IsNullOrEmpty(job.UserBook.Author) && !string.IsNullOrEmpty(result.Metadata.Authors))
                job.UserBook.Author = result.Metadata.Authors;

            // Prefer extracted EPUB language over upload-time guess. PDF returns null → keep user's choice.
            if (!string.IsNullOrEmpty(result.Metadata.Language))
                job.UserBook.Language = result.Metadata.Language;

            job.UserBook.TotalWordCount = result.Units.Sum(u => u.WordCount ?? 0);

            // If title was auto-generated, update with extracted title
            if (!string.IsNullOrEmpty(result.Metadata.Title))
            {
                // Both forms: books uploaded before the placeholder was cleaned hold the raw name.
                var originalFileName = Path.GetFileNameWithoutExtension(job.UserBookFile.OriginalFileName);
                if (job.UserBook.Title == originalFileName
                    || job.UserBook.Title == Application.UserBooks.UserBookService.TitleFromFileName(job.UserBookFile.OriginalFileName))
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

            // Mark success + enqueue enrichment. Pending is set in the SAME save as Ready so the sweep
            // (or the inline-kick below) can atomically claim it — visible status from the first moment.
            job.UserBook.Status = UserBookStatus.Ready;
            job.UserBook.MetadataEnrichmentStatus = MetadataEnrichmentStatus.Pending;
            job.UserBook.MetadataEnrichmentAt = null;
            job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;
            job.Status = JobStatus.Succeeded;
            job.UnitsCount = result.Units.Count;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Error = null;

            await db.SaveChangesAsync(ct);

            var bookId = job.UserBookId;
            var bookTitle = job.UserBook.Title;
            var bookAuthor = job.UserBook.Author;
            var bookLanguage = job.UserBook.Language;
            var bookUserId = job.UserBook.UserId;
            var firstChapterExcerpt = result.Units.FirstOrDefault()?.PlainText;
            var bookHasTags = job.UserBook.Tags.Length > 0;

            // Fire-and-forget metadata enrichment (genre, year, description) through the shared executor.
            // The atomic Pending → Running claim inside makes this immediate kick safe against the sweep
            // grabbing the same row; enrichment always lands on a terminal status (Completed / Failed).
            _ = Task.Run(() => _enrichmentService.EnrichAsync(bookId, CancellationToken.None));

            // Fire-and-forget: AI auto-tags via Ollama (slice 17). Skip if user already tagged.
            if (!bookHasTags)
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await using var bgDb = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
                        var nativeLang = await bgDb.Users
                            .Where(u => u.Id == bookUserId)
                            .Select(u => u.NativeLanguage)
                            .FirstOrDefaultAsync(CancellationToken.None);

                        var tags = await _tagGenerator.GenerateAsync(
                            bookTitle, bookAuthor, bookLanguage, firstChapterExcerpt,
                            nativeLang, CancellationToken.None);

                        if (tags.Length == 0) return;

                        var book = await bgDb.UserBooks.FirstOrDefaultAsync(
                            b => b.Id == bookId, CancellationToken.None);
                        if (book is null) return;

                        // Don't overwrite if user has tagged in the meantime
                        if (book.Tags.Length > 0) return;

                        book.SuggestedTags = tags;
                        book.SuggestedTagsAt = DateTimeOffset.UtcNow;
                        book.UpdatedAt = DateTimeOffset.UtcNow;
                        // Status-safety here relies on EF issuing a column-granular UPDATE (only the modified
                        // columns above — never MetadataEnrichmentStatus). This runs on a SEPARATE DbContext,
                        // concurrently with the enrichment task that owns the enrichment-status column. A future
                        // switch to a full-entity update (UpdateRange / raw UPDATE that writes all columns) on
                        // this path would clobber whatever enrichment status the other task has written.
                        await bgDb.SaveChangesAsync(CancellationToken.None);
                    }
                    catch (HttpRequestException ex)
                    {
                        _logger.LogWarning(ex, "Ollama unavailable for tag suggestion {BookId}", bookId);
                    }
                    catch (TaskCanceledException)
                    {
                        _logger.LogWarning("Ollama timeout for tag suggestion {BookId}", bookId);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to generate tag suggestions {BookId}", bookId);
                    }
                });
            }

            _logger.LogInformation("User book job {JobId} completed. {ChapterCount} chapters created.",
                jobId, result.Units.Count);

            // Auto-queue quality validation if enabled
            await IngestionWorkerService.TryQueueQualityJobAsync(db, null, job.UserBook.Id, _logger, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "User book job {JobId} failed", jobId);

            job.Status = JobStatus.Failed;
            job.FinishedAt = DateTimeOffset.UtcNow;
            job.Error = ex.Message;

            job.UserBook.Status = UserBookStatus.Failed;
            job.UserBook.ErrorMessage = "Could not read this file. It may be corrupted or password-protected.";
            job.UserBook.UpdatedAt = DateTimeOffset.UtcNow;

            await db.SaveChangesAsync(CancellationToken.None);
        }
    }


    private static string MapToFriendlyError(ExtractionWarningCode? code) => code switch
    {
        ExtractionWarningCode.NoTextLayer =>
            "This file contains only images without extractable text.",
        ExtractionWarningCode.EmptyContent =>
            "This file appears to be empty.",
        ExtractionWarningCode.ParseError =>
            "Could not read this file. It may be corrupted or password-protected.",
        _ =>
            "This file format is not supported."
    };
}
