using System.Text.RegularExpressions;
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

    /// <summary>
    /// Get statistics about what will be reprocessed
    /// </summary>
    public async Task<ReprocessingStats> GetReprocessingStatsAsync(Guid? siteId, CancellationToken ct)
    {
        // Get site's MaxWordsPerPart setting
        var maxWords = DefaultMaxWordsPerPart;
        if (siteId.HasValue)
        {
            var site = await db.Sites.FindAsync([siteId.Value], ct);
            if (site != null)
                maxWords = site.MaxWordsPerPart;
        }

        var query = db.Chapters.AsQueryable();

        if (siteId.HasValue)
            query = query.Where(c => c.Edition.SiteId == siteId.Value);

        var stats = await query
            .GroupBy(_ => 1)
            .Select(g => new
            {
                TotalChapters = g.Count(),
                ChaptersToSplit = g.Count(c => c.WordCount > maxWords),
                TotalWordsInLongChapters = g.Where(c => c.WordCount > maxWords).Sum(c => c.WordCount ?? 0),
                MaxWordCount = g.Max(c => c.WordCount ?? 0)
            })
            .FirstOrDefaultAsync(ct);

        if (stats is null)
            return new ReprocessingStats(0, 0, 0, 0, 0);

        // Estimate new parts using site's maxWords setting
        var estimatedParts = await query
            .Where(c => c.WordCount > maxWords)
            .Select(c => (int)Math.Ceiling((c.WordCount ?? 0) / (double)maxWords))
            .SumAsync(ct);

        var chaptersUnchanged = stats.TotalChapters - stats.ChaptersToSplit;
        var estimatedTotal = chaptersUnchanged + estimatedParts;

        return new ReprocessingStats(
            stats.TotalChapters,
            stats.ChaptersToSplit,
            estimatedParts,
            estimatedTotal,
            stats.MaxWordCount
        );
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

    private const int DefaultMaxWordsPerPart = 2000;

    /// <summary>
    /// Split existing long chapters directly in DB (no source file needed)
    /// Uses site's MaxWordsPerPart setting
    /// </summary>
    public async Task<SplitExistingResult> SplitExistingChaptersAsync(Guid? siteId, CancellationToken ct)
    {
        // First, get editions with their site settings
        var query = db.Editions
            .Include(e => e.Chapters)
            .Include(e => e.Site)
            .Where(e => e.Status == EditionStatus.Published);

        if (siteId.HasValue)
            query = query.Where(e => e.SiteId == siteId.Value);

        // Filter editions that have chapters exceeding their site's limit
        var editions = await query.ToListAsync(ct);
        editions = editions
            .Where(e => e.Chapters.Any(c => c.WordCount > (e.Site?.MaxWordsPerPart ?? DefaultMaxWordsPerPart)))
            .ToList();

        var results = new List<SplitEditionInfo>();
        var totalChaptersSplit = 0;
        var totalNewParts = 0;

        foreach (var edition in editions)
        {
            try
            {
                var maxWords = edition.Site?.MaxWordsPerPart ?? DefaultMaxWordsPerPart;
                var (chaptersSplit, newParts) = await SplitEditionChaptersAsync(edition, maxWords, ct);
                totalChaptersSplit += chaptersSplit;
                totalNewParts += newParts;
                results.Add(new SplitEditionInfo(edition.Id, edition.Title, chaptersSplit, newParts, null));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to split chapters for edition {EditionId}", edition.Id);
                results.Add(new SplitEditionInfo(edition.Id, edition.Title, 0, 0, ex.Message));
            }
        }

        var totalAfter = await db.Chapters.CountAsync(ct);

        return new SplitExistingResult(
            editions.Count,
            totalChaptersSplit,
            totalNewParts,
            totalAfter,
            results
        );
    }

    private async Task<(int ChaptersSplit, int NewParts)> SplitEditionChaptersAsync(Edition edition, int maxWordsPerPart, CancellationToken ct)
    {
        var longChapters = edition.Chapters
            .Where(c => c.WordCount > maxWordsPerPart)
            .OrderBy(c => c.ChapterNumber)
            .ToList();

        if (longChapters.Count == 0)
            return (0, 0);

        var chaptersSplit = 0;
        var newPartsCreated = 0;
        var newChaptersToAdd = new List<Chapter>();

        // Collect chapters to split and their parts
        var chaptersToSplit = new List<(Chapter Chapter, List<ChapterPart> Parts)>();
        foreach (var chapter in longChapters)
        {
            var parts = SplitChapterHtml(chapter, maxWordsPerPart);
            if (parts.Count > 1)
                chaptersToSplit.Add((chapter, parts));
        }

        // Create new chapter parts
        foreach (var (chapter, parts) in chaptersToSplit)
        {
            // Strip existing " - Part N" suffix from title to avoid "Part 1 - Part 1" on re-split
            var baseTitle = GetBaseTitle(chapter.Title);
            // Strip existing "-part-N" suffix from slug
            var baseSlug = Regex.Replace(chapter.Slug ?? "", @"-part-\d+$", "");

            for (var i = 0; i < parts.Count; i++)
            {
                var part = parts[i];
                var newChapter = new Chapter
                {
                    Id = Guid.NewGuid(),
                    EditionId = edition.Id,
                    ChapterNumber = 10000 + chapter.ChapterNumber * 100 + i, // Temp high number
                    Slug = i == 0 ? baseSlug : $"{baseSlug}-part-{i + 1}",
                    Title = $"{baseTitle} - Part {i + 1}",
                    Html = part.Html,
                    PlainText = part.PlainText,
                    WordCount = part.WordCount,
                    OriginalChapterNumber = chapter.ChapterNumber,
                    PartNumber = i + 1,
                    TotalParts = parts.Count,
                    CreatedAt = DateTimeOffset.UtcNow
                };
                newChaptersToAdd.Add(newChapter);
            }

            chaptersSplit++;
            newPartsCreated += parts.Count;
        }

        if (chaptersToSplit.Count == 0)
            return (0, 0);

        // Delete old long chapters that were split
        foreach (var (chapter, _) in chaptersToSplit)
        {
            db.Chapters.Remove(chapter);
        }
        await db.SaveChangesAsync(ct);

        // Add new parts
        foreach (var chapter in newChaptersToAdd)
        {
            db.Chapters.Add(chapter);
        }
        await db.SaveChangesAsync(ct);

        // Reorder all chapters sequentially
        await ReorderChaptersAsync(edition.Id, ct);

        logger.LogInformation("Split {Count} chapters into {Parts} parts for edition {EditionId}",
            chaptersSplit, newPartsCreated, edition.Id);

        return (chaptersSplit, newPartsCreated);
    }

    private async Task ReorderChaptersAsync(Guid editionId, CancellationToken ct)
    {
        var chapters = await db.Chapters
            .Where(c => c.EditionId == editionId)
            .OrderBy(c => c.OriginalChapterNumber ?? c.ChapterNumber)
            .ThenBy(c => c.PartNumber ?? 0)
            .ToListAsync(ct);

        for (var i = 0; i < chapters.Count; i++)
        {
            chapters[i].ChapterNumber = i;
        }

        await db.SaveChangesAsync(ct);
    }

    private record ChapterPart(string Html, string PlainText, int WordCount);

    private List<ChapterPart> SplitChapterHtml(Chapter chapter, int maxWordsPerPart)
    {
        if (string.IsNullOrEmpty(chapter.Html))
            return [new ChapterPart(chapter.Html ?? "", chapter.PlainText ?? "", chapter.WordCount ?? 0)];

        // Split by block elements (paragraphs, divs, table rows, list items)
        var paragraphPattern = new Regex(@"(<p[^>]*>.*?</p>|<div[^>]*>.*?</div>|<tr[^>]*>.*?</tr>|<li[^>]*>.*?</li>)",
            RegexOptions.Singleline | RegexOptions.IgnoreCase);
        var matches = paragraphPattern.Matches(chapter.Html);

        if (matches.Count == 0)
            return [new ChapterPart(chapter.Html, chapter.PlainText ?? "", chapter.WordCount ?? 0)];

        var parts = new List<ChapterPart>();
        var currentHtml = new System.Text.StringBuilder();
        var currentWordCount = 0;

        foreach (Match match in matches)
        {
            var paragraphHtml = match.Value;
            var paragraphText = StripHtml(paragraphHtml);
            var paragraphWords = CountWords(paragraphText);

            // If adding this paragraph exceeds limit and we have content, start new part
            if (currentWordCount > 0 && currentWordCount + paragraphWords > maxWordsPerPart)
            {
                var html = currentHtml.ToString();
                parts.Add(new ChapterPart(html, StripHtml(html), currentWordCount));
                currentHtml.Clear();
                currentWordCount = 0;
            }

            currentHtml.Append(paragraphHtml);
            currentWordCount += paragraphWords;
        }

        // Add remaining content
        if (currentHtml.Length > 0)
        {
            var html = currentHtml.ToString();
            parts.Add(new ChapterPart(html, StripHtml(html), currentWordCount));
        }

        return parts;
    }

    private static string StripHtml(string html)
    {
        if (string.IsNullOrEmpty(html)) return "";
        var text = Regex.Replace(html, "<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        return Regex.Replace(text, @"\s+", " ").Trim();
    }

    private static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return 0;
        return text.Split([' ', '\t', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries).Length;
    }

    /// <summary>
    /// Strip existing " - Part N" suffix to avoid "Part 1 - Part 1" on re-split
    /// </summary>
    private static string GetBaseTitle(string title)
    {
        var partPattern = new Regex(@"\s*-\s*Part\s+\d+$", RegexOptions.IgnoreCase);
        return partPattern.Replace(title, "");
    }
}

public record ReprocessingStats(
    int TotalChapters,
    int ChaptersToSplit,
    int EstimatedNewParts,
    int EstimatedTotalAfter,
    int MaxWordCount
);

public record SplitExistingResult(
    int EditionsProcessed,
    int ChaptersSplit,
    int NewPartsCreated,
    int TotalChaptersAfter,
    List<SplitEditionInfo> Editions
);

public record SplitEditionInfo(
    Guid EditionId,
    string Title,
    int ChaptersSplit,
    int NewParts,
    string? Error
);
