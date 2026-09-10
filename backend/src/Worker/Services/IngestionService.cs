using System.Diagnostics;
using System.Text.Json;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Infrastructure.Telemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Lint;
using TextStack.Extraction.Registry;
using TextStack.Search.Abstractions;
using TextStack.Search.Contracts;
using TextStack.Search.Enums;
using AppIngestion = Application.Ingestion;

namespace Worker.Services;

public class IngestionWorkerService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IFileStorageService _storage;
    private readonly IExtractorRegistry _extractorRegistry;
    private readonly ISearchIndexer _searchIndexer;
    private readonly IImageOptimizer _imageOptimizer;
    private readonly ILogger<IngestionWorkerService> _logger;
    private readonly ILogger<AppIngestion.IngestionService> _ingestionLogger;

    public IngestionWorkerService(
        IDbContextFactory<AppDbContext> dbFactory,
        IFileStorageService storage,
        IExtractorRegistry extractorRegistry,
        ISearchIndexer searchIndexer,
        IImageOptimizer imageOptimizer,
        ILogger<IngestionWorkerService> logger,
        ILogger<AppIngestion.IngestionService> ingestionLogger)
    {
        _dbFactory = dbFactory;
        _storage = storage;
        _extractorRegistry = extractorRegistry;
        _searchIndexer = searchIndexer;
        _imageOptimizer = imageOptimizer;
        _logger = logger;
        _ingestionLogger = ingestionLogger;
    }

    public async Task<IngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        using var activity = IngestionActivitySource.Source.StartActivity("ingestion.job.pick");

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var service = new AppIngestion.IngestionService(db, _storage, _ingestionLogger);
        var job = await service.GetNextJobAsync(ct);

        activity?.SetTag("job.found", job is not null);
        if (job is not null)
        {
            activity?.SetTag("ingestion.job_id", job.Id.ToString());
        }

        return job;
    }

    public async Task<(int PendingCount, double OldestJobAgeMs)> GetQueueStatsAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var pendingJobs = await db.IngestionJobs
            .Where(j => j.Status == Domain.Enums.JobStatus.Queued)
            .Select(j => j.CreatedAt)
            .ToListAsync(ct);

        if (pendingJobs.Count == 0)
            return (0, 0);

        var oldestJob = pendingJobs.Min();
        var ageMs = (DateTimeOffset.UtcNow - oldestJob).TotalMilliseconds;

        return (pendingJobs.Count, ageMs);
    }

    public async Task ProcessJobAsync(Guid jobId, CancellationToken ct)
    {
        using var activity = IngestionActivitySource.Source.StartActivity("ingestion.job.process");
        activity?.SetTag("ingestion.job_id", jobId.ToString());

        var stopwatch = Stopwatch.StartNew();
        string? sourceFormat = null;
        string? textSource = null;
        string? failureReason = null;

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var service = new AppIngestion.IngestionService(db, _storage, _ingestionLogger);

        var job = await service.GetJobWithDetailsAsync(jobId, ct);

        if (job is null)
        {
            _logger.LogWarning("Job {JobId} not found", jobId);
            activity?.SetStatus(ActivityStatusCode.Error, "Job not found");
            return;
        }

        activity?.SetTag("edition_id", job.EditionId.ToString());
        _logger.LogInformation("Processing job {JobId} for edition {EditionId}", jobId, job.EditionId);

        ExtractionResult? extractionResult = null;

        try
        {
            await service.MarkJobProcessingAsync(job, ct);

            // Record job started metric
            IngestionMetrics.JobsStarted.Add(1, new KeyValuePair<string, object?>("format", "unknown"));

            // File open span
            string filePath;
            using (var fileOpenActivity = IngestionActivitySource.Source.StartActivity("ingestion.file.open"))
            {
                filePath = service.GetFilePath(job.BookFile.StoragePath);
                fileOpenActivity?.SetTag("file.exists", File.Exists(filePath));

                if (!File.Exists(filePath))
                {
                    throw new FileNotFoundException($"Book file not found: {filePath}");
                }
            }

            await using var fileStream = File.OpenRead(filePath);
            var request = new ExtractionRequest
            {
                Content = fileStream,
                FileName = job.BookFile.OriginalFileName,
                ContentLength = fileStream.Length,
                // Admin catalog PDFs render via reflow and need their inline
                // figures (ADR-012 S5a — gate, don't delete).
                Options = new ExtractionOptions { ExtractInlineImages = true }
            };

            // Extraction span
            var extractionStopwatch = Stopwatch.StartNew();
            using (var extractActivity = IngestionActivitySource.Source.StartActivity("extraction.run"))
            {
                var extractor = _extractorRegistry.Resolve(request);
                extractionResult = await extractor.ExtractAsync(request, ct);

                sourceFormat = extractionResult.SourceFormat.ToString();
                textSource = extractionResult.Diagnostics.TextSource.ToString();

                extractActivity?.SetTag("source_format", sourceFormat);
                extractActivity?.SetTag("text_source", textSource);
                extractActivity?.SetTag("units_count", extractionResult.Units.Count);
                extractActivity?.SetTag("confidence", extractionResult.Diagnostics.Confidence);
            }
            extractionStopwatch.Stop();

            // Record extraction metrics
            IngestionMetrics.ExtractionDuration.Record(
                extractionStopwatch.Elapsed.TotalMilliseconds,
                new KeyValuePair<string, object?>("format", sourceFormat),
                new KeyValuePair<string, object?>("text_source", textSource));

            // Track OCR usage
            if (extractionResult.Diagnostics.TextSource == TextSource.Ocr)
            {
                IngestionMetrics.OcrUsed.Add(1, new KeyValuePair<string, object?>("format", sourceFormat));
            }

            if (extractionResult.Diagnostics.TextSource == TextSource.None)
            {
                var warning = extractionResult.Diagnostics.Warnings.FirstOrDefault()?.Message ?? "Unsupported format";
                failureReason = "no_text_layer";
                throw new NotSupportedException(warning);
            }

            // Save inline images and build path->assetId map
            var imageMap = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
            if (extractionResult.Images.Count > 0)
            {
                using var imagesActivity = IngestionActivitySource.Source.StartActivity("persist.images");
                imagesActivity?.SetTag("images.count", extractionResult.Images.Count);

                foreach (var image in extractionResult.Images)
                {
                    if (image.IsCover) continue; // Cover saved separately

                    try
                    {
                        var assetId = Guid.NewGuid();
                        var optimized = await _imageOptimizer.OptimizeAsync(image.Data, image.MimeType, ct: ct);
                        var ext = optimized.Extension;
                        using var imageStream = new MemoryStream(optimized.Data);
                        var storagePath = await _storage.SaveFileAsync(
                            job.EditionId,
                            $"assets/{assetId}{ext}",
                            imageStream,
                            ct);

                        var asset = new BookAsset
                        {
                            Id = assetId,
                            EditionId = job.EditionId,
                            Kind = AssetKind.InlineImage,
                            OriginalPath = image.OriginalPath,
                            StoragePath = storagePath,
                            ContentType = optimized.MimeType,
                            ByteSize = optimized.Data.Length,
                            CreatedAt = DateTimeOffset.UtcNow
                        };
                        db.BookAssets.Add(asset);
                        imageMap[image.OriginalPath] = assetId;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to save image {Path} for edition {EditionId}",
                            image.OriginalPath, job.EditionId);
                    }
                }

                if (imageMap.Count > 0)
                {
                    await db.SaveChangesAsync(ct);
                    _logger.LogInformation("Saved {Count} images for edition {EditionId}",
                        imageMap.Count, job.EditionId);
                }
            }

            var parsed = MapToApplicationModel(extractionResult, imageMap, job.EditionId);
            var summary = MapToExtractionSummary(extractionResult);

            // Serialize ToC to JSON
            string? tocJson = null;
            if (extractionResult.Toc is { Count: > 0 })
            {
                tocJson = JsonSerializer.Serialize(extractionResult.Toc, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    WriteIndented = false
                });
            }

            _logger.LogInformation("Parsed {ChapterCount} chapters from {Title}",
                parsed.Chapters.Count, parsed.Title);

            // Save cover image if extracted
            if (extractionResult.Metadata.CoverImage is { Length: > 0 })
            {
                using var coverActivity = IngestionActivitySource.Source.StartActivity("persist.cover");
                try
                {
                    var coverMime = extractionResult.Metadata.CoverMimeType ?? "image/jpeg";
                    var optimizedCover = await _imageOptimizer.OptimizeAsync(
                        extractionResult.Metadata.CoverImage, coverMime, ct: ct);
                    var ext = optimizedCover.Extension;

                    using var coverStream = new MemoryStream(optimizedCover.Data);
                    var coverPath = await _storage.SaveFileAsync(job.EditionId, $"cover{ext}", coverStream, ct);

                    // Update edition with cover path
                    var edition = await db.Editions.FindAsync([job.EditionId], ct);
                    if (edition is not null)
                    {
                        edition.CoverPath = coverPath;
                        edition.UpdatedAt = DateTimeOffset.UtcNow;
                        await db.SaveChangesAsync(ct);
                    }

                    coverActivity?.SetTag("cover.saved", true);
                    coverActivity?.SetTag("cover.size", extractionResult.Metadata.CoverImage.Length);
                    _logger.LogInformation("Saved cover for edition {EditionId}: {CoverPath}", job.EditionId, coverPath);
                }
                catch (Exception ex)
                {
                    coverActivity?.SetTag("cover.saved", false);
                    _logger.LogWarning(ex, "Failed to save cover for edition {EditionId}", job.EditionId);
                }
            }

            // Persist result span
            using (var persistActivity = IngestionActivitySource.Source.StartActivity("persist.result"))
            {
                await service.ProcessParsedBookAsync(job, parsed, summary, tocJson, ct);
                persistActivity?.SetTag("chapters_count", parsed.Chapters.Count);
            }

            // Index chapters for search
            using (var indexActivity = IngestionActivitySource.Source.StartActivity("search.index"))
            {
                await IndexChaptersForSearchAsync(db, job.EditionId, ct);
                indexActivity?.SetTag("chapters_indexed", parsed.Chapters.Count);
            }


            // Run linter and save results
            using (var lintActivity = IngestionActivitySource.Source.StartActivity("lint.run"))
            {
                await RunLinterAsync(db, job.EditionId, extractionResult.Units, ct);
                lintActivity?.SetTag("lint.completed", true);
            }

            _logger.LogInformation("Job {JobId} completed successfully. {ChapterCount} chapters created.",
                jobId, parsed.Chapters.Count);

            // Auto-queue quality validation if enabled
            await TryQueueQualityJobAsync(db, job.EditionId, null, ct);

            // Record success metric
            stopwatch.Stop();
            IngestionMetrics.JobsSucceeded.Add(1, new KeyValuePair<string, object?>("format", sourceFormat));
            IngestionMetrics.JobDuration.Record(
                stopwatch.Elapsed.TotalMilliseconds,
                new KeyValuePair<string, object?>("format", sourceFormat));

            activity?.SetStatus(ActivityStatusCode.Ok);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Job {JobId} failed", jobId);

            // Determine failure reason
            failureReason ??= ex switch
            {
                FileNotFoundException => "file_not_found",
                NotSupportedException => "unsupported",
                _ => "parse_error"
            };

            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddEvent(new ActivityEvent("exception", tags: new ActivityTagsCollection
            {
                { "exception.type", ex.GetType().FullName },
                { "exception.message", ex.Message },
                { "exception.stacktrace", ex.StackTrace }
            }));

            // Record failure metric
            stopwatch.Stop();
            IngestionMetrics.JobsFailed.Add(1,
                new KeyValuePair<string, object?>("format", sourceFormat ?? "unknown"),
                new KeyValuePair<string, object?>("reason", failureReason));
            IngestionMetrics.JobDuration.Record(
                stopwatch.Elapsed.TotalMilliseconds,
                new KeyValuePair<string, object?>("format", sourceFormat ?? "unknown"));

            // Persist diagnostics even on failure
            var summary = extractionResult is not null
                ? MapToExtractionSummary(extractionResult)
                : null;

            await service.MarkJobFailedAsync(job, ex.Message, summary, CancellationToken.None);
        }
    }

    private static AppIngestion.ParsedBook MapToApplicationModel(
        ExtractionResult result,
        Dictionary<string, Guid> imageMap,
        Guid editionId)
    {
        var chapters = result.Units
            .Select(u => new AppIngestion.ParsedChapter(
                u.OrderIndex,
                u.Title ?? $"Chapter {u.OrderIndex + 1}",
                Application.Common.ImageProcessingHelper.RewriteImageSrcs(
                    u.Html ?? string.Empty,
                    imageMap.ToDictionary(kv => kv.Key, kv => $"/books/{editionId}/assets/{kv.Value}")),
                u.PlainText,
                u.WordCount ?? 0,
                u.OriginalChapterNumber,
                u.PartNumber,
                u.TotalParts))
            .ToList();

        return new AppIngestion.ParsedBook(
            result.Metadata.Title,
            result.Metadata.Authors,
            result.Metadata.Description,
            chapters);
    }


    private static AppIngestion.ExtractionSummary MapToExtractionSummary(ExtractionResult result)
    {
        var warnings = result.Diagnostics.Warnings
            .Select(w => new AppIngestion.ExtractionWarningDto((int)w.Code, w.Message))
            .ToList();

        return new AppIngestion.ExtractionSummary(
            result.SourceFormat.ToString(),
            result.Units.Count,
            result.Diagnostics.TextSource.ToString(),
            result.Diagnostics.Confidence,
            warnings
        );
    }

    private async Task IndexChaptersForSearchAsync(AppDbContext db, Guid editionId, CancellationToken ct)
    {
        var edition = await db.Editions
            .Include(e => e.Chapters)
            .Include(e => e.Work)
            .Include(e => e.EditionAuthors)
                .ThenInclude(ea => ea.Author)
            .FirstOrDefaultAsync(e => e.Id == editionId, ct);

        if (edition is null)
        {
            _logger.LogWarning("Edition {EditionId} not found for search indexing", editionId);
            return;
        }

        var language = MapLanguageToSearchLanguage(edition.Language);
        var authors = string.Join(", ", edition.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name));

        var documents = edition.Chapters.Select(chapter => new IndexDocument(
            Id: chapter.Id.ToString(),
            Title: chapter.Title ?? $"Chapter {chapter.ChapterNumber}",
            Content: chapter.PlainText ?? string.Empty,
            Language: language,
            SiteId: edition.Work.SiteId,
            Metadata: new Dictionary<string, object>
            {
                ["chapterId"] = chapter.Id,
                ["chapterSlug"] = chapter.Slug ?? string.Empty,
                ["chapterTitle"] = chapter.Title ?? string.Empty,
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
            await _searchIndexer.IndexBatchAsync(documents, ct);
            _logger.LogInformation("Indexed {Count} chapters for edition {EditionId}", documents.Count, editionId);
        }
    }

    private static SearchLanguage MapLanguageToSearchLanguage(string language)
    {
        return language.ToLowerInvariant() switch
        {
            "en" => SearchLanguage.En,
            _ => SearchLanguage.Auto
        };
    }

    private async Task RunLinterAsync(
        AppDbContext db,
        Guid editionId,
        IReadOnlyList<ContentUnit> units,
        CancellationToken ct)
    {
        try
        {
            // Clear existing lint results
            var existingResults = await db.LintResults
                .Where(r => r.EditionId == editionId)
                .ToListAsync(ct);
            db.LintResults.RemoveRange(existingResults);

            // Run linter on all chapters
            var linter = new Linter();
            var chapters = units
                .Where(u => u.Html != null)
                .Select(u => (u.OrderIndex + 1, u.Html!))
                .ToList();

            var issues = linter.LintAll(chapters);

            // Save lint results (limit to 1000 per edition to avoid bloat)
            var resultsToSave = issues.Take(1000).Select(issue => new LintResult
            {
                Id = Guid.NewGuid(),
                EditionId = editionId,
                Severity = MapLintSeverity(issue.Severity),
                Code = issue.Code,
                Message = issue.Message,
                ChapterNumber = issue.ChapterNumber,
                LineNumber = issue.LineNumber,
                Context = issue.Context?.Length > 200 ? issue.Context[..200] : issue.Context,
                CreatedAt = DateTimeOffset.UtcNow
            }).ToList();

            db.LintResults.AddRange(resultsToSave);
            await db.SaveChangesAsync(ct);

            _logger.LogInformation("Lint completed for edition {EditionId}: {IssueCount} issues found",
                editionId, resultsToSave.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Linting failed for edition {EditionId}", editionId);
            // Don't fail the job if linting fails
        }
    }

    private static Domain.Enums.LintSeverity MapLintSeverity(TextStack.Extraction.Lint.LintSeverity severity)
    {
        return severity switch
        {
            TextStack.Extraction.Lint.LintSeverity.Error => Domain.Enums.LintSeverity.Error,
            TextStack.Extraction.Lint.LintSeverity.Warning => Domain.Enums.LintSeverity.Warning,
            _ => Domain.Enums.LintSeverity.Info
        };
    }

    private async Task TryQueueQualityJobAsync(AppDbContext db, Guid? editionId, Guid? userBookId, CancellationToken ct)
    {
        try
        {
            var settingKey = editionId.HasValue ? "quality.autoQueueAfterIngestion" : "quality.autoQueueForUserBooks";
            var enabled = await db.AdminSettings
                .Where(s => s.Key == settingKey)
                .Select(s => s.Value)
                .FirstOrDefaultAsync(ct);

            if (enabled != "true") return;

            db.BookQualityJobs.Add(new BookQualityJob
            {
                Id = Guid.NewGuid(),
                EditionId = editionId,
                UserBookId = userBookId,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync(ct);

            _logger.LogInformation("Queued quality validation for {Type} {Id}",
                editionId.HasValue ? "edition" : "user book",
                editionId ?? userBookId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to queue quality job — non-blocking");
        }
    }
}
