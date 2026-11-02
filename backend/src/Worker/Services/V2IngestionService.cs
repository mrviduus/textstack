using Application.Ingestion;
using Application.Library;
using Application.Transitional;
using Domain.Transitional;
using Domain.Utilities;
using Infrastructure.Telemetry;
using Microsoft.Extensions.Logging;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Registry;
using static Contracts.V2.SyncLimits;
using Application.Sync;
using static TextStack.Extraction.Utilities.TextProcessingUtils;

namespace Worker.Services;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>Extracts the chapters of uploaded V2 files into <c>book_chapters</c> (the extraction half of
/// legacy's <see cref="UserIngestionService"/>; metadata stays the client's, owner decision 5), and
/// sweeps the bytes the library no longer needs: day-old upload parts and orphans.</para>
/// </summary>
public sealed class V2IngestionService(
    IIngestionJobRepository jobs, ILibraryRepository library, IBookChapterRepository chapters,
    ILibraryFileStore files, IExtractorRegistry extractors, ILogger<V2IngestionService> logger)
{
    private const int MaxAttempts = IngestionService.MaxAttempts;
    private static readonly TimeSpan StuckAfter = UserIngestionService.StuckJobTimeout;

    // A file younger than this may be an attach or a cover between its place and its commit, and a
    // directory that young may be about to receive one: neither is an orphan yet.
    private static readonly TimeSpan OrphanAge = TimeSpan.FromHours(1);

    /// <summary>Fails exhausted jobs, then claims and runs the next one; false when the queue is empty.</summary>
    public async Task<bool> ProcessNextAsync(CancellationToken ct)
    {
        foreach (var exhausted in await jobs.FailExhaustedAsync(MaxAttempts, StuckAfter, IngestionService.ExceededAttemptsError, ct))
            logger.LogWarning("V2 ingestion job {JobId} of file {FileId} exceeded {Max} attempts, marked failed", exhausted.Id, exhausted.FileId, MaxAttempts);
        var job = await jobs.ClaimNextAsync(MaxAttempts, StuckAfter, ct);
        if (job is null) return false;
        await ProcessAsync(job, ct);
        return true;
    }

    /// <summary>
    /// One claimed job: extract, replace the file's chapters, finish. A bad file fails it (the extractors
    /// report unreadable input as diagnostics, not exceptions). Anything that throws is the server's
    /// trouble (disk, database): the job stays processing, so the stuck reclaim retries it and
    /// <see cref="MaxAttempts"/> ends it. A shutdown gives it back (ADR-022).
    /// </summary>
    public async Task ProcessAsync(FileIngestionJob job, CancellationToken ct)
    {
        try
        {
            var file = await library.GetFileAsync(job.UserId, job.BookId, job.FileId, ct);
            if (file?.ServerStorageKey is not { } key || files.Locate(key) is not { } path)
            {
                await jobs.FailAsync(job.Id, job.AttemptCount, "The file's bytes are not on the server.", null, ct);
                return;
            }
            await using var content = File.OpenRead(path);
            var request = new ExtractionRequest
            {
                Content = content,
                // The stored format, not the client's file name, picks the extractor.
                FileName = $"{file.Id}.{file.Format}",
                ContentLength = content.Length,
                // ponytail: inline images are not stored; the V2 reader renders the file itself. Store them
                // (as legacy's assets) if a transitional reader shows image-heavy books broken.
                Options = new ExtractionOptions { ExtractInlineImages = false },
            };
            var result = await extractors.Resolve(request).ExtractAsync(request, ct);
            // Extractors throw on cancellation; this keeps a partial result from reading as a broken file.
            ct.ThrowIfCancellationRequested();

            var sourceFormat = result.SourceFormat.ToString().ToLowerInvariant();
            var unreadable = result.Diagnostics.TextSource == TextSource.None
                ? result.Diagnostics.Warnings.FirstOrDefault()?.Message ?? "Unsupported format"
                : result.Units.Count == 0 ? "No readable content extracted" : null;
            if (unreadable is not null)
            {
                await jobs.FailAsync(job.Id, job.AttemptCount, unreadable, sourceFormat, ct);
                return;
            }
            await chapters.ReplaceForFileAsync(job.UserId, job.BookId, job.FileId, ToChapters(result.Units), ct);
            await jobs.SucceedAsync(job.Id, job.AttemptCount, sourceFormat, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            var returned = await jobs.ReturnToQueueAsync(job.Id, job.AttemptCount, CancellationToken.None);
            logger.LogInformation("V2 ingestion job {JobId} interrupted by shutdown; returned to queue: {Returned}", job.Id, returned);
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "V2 ingestion job {JobId} of file {FileId} failed on attempt {Attempt} of {Max}; left processing for the stuck reclaim",
                job.Id, job.FileId, job.AttemptCount, MaxAttempts);
        }
    }

    /// <summary>
    /// Chapters numbered densely 1..N in this loop's order, not by <c>OrderIndex</c>: the extractor skips
    /// units (empty ones, watermarks, the navigation document), so <c>OrderIndex</c> has gaps. The same
    /// counter orders the key (ADR-031 decided 6), so keys are unique and never empty.
    /// </summary>
    public static List<BookChapter> ToChapters(IReadOnlyList<ContentUnit> units)
    {
        var chapters = new List<BookChapter>(units.Count);
        foreach (var unit in units)
        {
            var index = chapters.Count;
            var title = SyncValidation.Truncate(SanitizeText(unit.Title ?? $"Chapter {index + 1}"), MaxChapterTitle);
            chapters.Add(new BookChapter
            {
                Id = Guid.NewGuid(),
                // Capped as the read endpoint's key is; the order prefix keeps it unique.
                ChapterKey = SyncValidation.Truncate(SlugGenerator.GenerateChapterSlug(title, index), MaxChapterKey),
                ChapterNumber = index + 1,
                Title = title,
                Html = SanitizeText(unit.Html),
                PlainText = SanitizeText(unit.PlainText),
                WordCount = unit.WordCount,
                SourceStartPage = unit.SourceStartPage,
                SourceEndPage = unit.SourceEndPage,
            });
        }
        return chapters;
    }

    /// <summary>
    /// Deletes upload parts untouched for a day, then sets the stuck-jobs gauge. Superseded bytes go at
    /// replace time; a removed book keeps its bytes (removal is a hide, owner decision 11).
    /// </summary>
    public async Task SweepAsync(CancellationToken ct)
    {
        files.SweepStaleParts(DateTimeOffset.UtcNow);
        IngestionMetrics.SetStuckJobs("v2_ingestion", await jobs.CountStuckAsync(StuckAfter, ct));
    }

    /// <summary>
    /// Deletes bytes under <c>library/</c> older than <see cref="OrphanAge"/> that no file or cover names,
    /// then empty directories. One mechanism for every way bytes lose their row: a commit that failed
    /// after the place, a merge's dropped guest copies, a crashed join's temp file, a key cleared whose
    /// delete failed. The keys are read first: a file written after that is younger than the cutoff.
    /// </summary>
    public async Task SweepOrphansAsync(CancellationToken ct)
    {
        var referenced = await library.AllStorageKeysAsync(ct);
        var cutoff = DateTimeOffset.UtcNow - OrphanAge;
        foreach (var key in files.EnumerateLibraryFilesOlderThan(cutoff))
            if (!referenced.Contains(key) && !files.TryDelete(key))
                logger.LogWarning("Could not delete orphan V2 bytes at {StorageKey}; retried next sweep", key);
        files.RemoveEmptyDirectories(cutoff);
    }
}
