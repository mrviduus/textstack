using System.Diagnostics;
using Application.Common.Interfaces;
using Domain.Entities;
using Infrastructure.Persistence;
using Infrastructure.Telemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Registry;
using OnlineLib.Search.Abstractions;
using OnlineLib.Search.Contracts;
using OnlineLib.Search.Enums;
using AppIngestion = Application.Ingestion;

namespace Worker.Services;

public class IngestionWorkerService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IFileStorageService _storage;
    private readonly IExtractorRegistry _extractorRegistry;
    private readonly ISearchIndexer _searchIndexer;
    private readonly ILogger<IngestionWorkerService> _logger;

    public IngestionWorkerService(
        IDbContextFactory<AppDbContext> dbFactory,
        IFileStorageService storage,
        IExtractorRegistry extractorRegistry,
        ISearchIndexer searchIndexer,
        ILogger<IngestionWorkerService> logger)
    {
        _dbFactory = dbFactory;
        _storage = storage;
        _extractorRegistry = extractorRegistry;
        _searchIndexer = searchIndexer;
        _logger = logger;
    }

    public async Task<IngestionJob?> GetNextJobAsync(CancellationToken ct)
    {
        using var activity = IngestionActivitySource.Source.StartActivity("ingestion.job.pick");

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var service = new AppIngestion.IngestionService(db, _storage);
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
        var service = new AppIngestion.IngestionService(db, _storage);

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
            // Use site's MaxWordsPerPart setting for chapter splitting
            var maxWordsPerPart = job.Edition.Site?.MaxWordsPerPart
                                  ?? ExtractionOptions.Default.MaxWordsPerPart;
            var request = new ExtractionRequest
            {
                Content = fileStream,
                FileName = job.BookFile.OriginalFileName,
                ContentLength = fileStream.Length,
                Options = new ExtractionOptions { MaxWordsPerPart = maxWordsPerPart }
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

            var parsed = MapToApplicationModel(extractionResult);
            var summary = MapToExtractionSummary(extractionResult);

            _logger.LogInformation("Parsed {ChapterCount} chapters from {Title}",
                parsed.Chapters.Count, parsed.Title);

            // Save cover image if extracted
            if (extractionResult.Metadata.CoverImage is { Length: > 0 })
            {
                using var coverActivity = IngestionActivitySource.Source.StartActivity("persist.cover");
                try
                {
                    var ext = extractionResult.Metadata.CoverMimeType switch
                    {
                        "image/png" => ".png",
                        "image/gif" => ".gif",
                        "image/webp" => ".webp",
                        _ => ".jpg"
                    };

                    using var coverStream = new MemoryStream(extractionResult.Metadata.CoverImage);
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
                await service.ProcessParsedBookAsync(job, parsed, summary, ct);
                persistActivity?.SetTag("chapters_count", parsed.Chapters.Count);
            }

            // Index chapters for search
            using (var indexActivity = IngestionActivitySource.Source.StartActivity("search.index"))
            {
                await IndexChaptersForSearchAsync(db, job.EditionId, ct);
                indexActivity?.SetTag("chapters_indexed", parsed.Chapters.Count);
            }

            _logger.LogInformation("Job {JobId} completed successfully. {ChapterCount} chapters created.",
                jobId, parsed.Chapters.Count);

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

    private static AppIngestion.ParsedBook MapToApplicationModel(ExtractionResult result)
    {
        var chapters = result.Units
            .Select(u => new AppIngestion.ParsedChapter(
                u.OrderIndex,
                u.Title ?? $"Chapter {u.OrderIndex + 1}",
                u.Html ?? string.Empty,
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
            "uk" => SearchLanguage.Uk,
            "en" => SearchLanguage.En,
            _ => SearchLanguage.Auto
        };
    }
}
