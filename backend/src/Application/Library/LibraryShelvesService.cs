using Application.Common.Interfaces;
using Contracts.Library;
using Microsoft.EntityFrameworkCore;

namespace Application.Library;

public class LibraryShelvesService(IAppDbContext db)
{
    private const int ShelfLimit = 10;
    private const int RecentlyAddedDays = 14;
    private const int QuickReadMaxMinutes = 60;
    private const double InProgressMinPercent = 0.0;
    private const double InProgressMaxPercent = 0.95;
    private const decimal MinSanePace = 50m;
    private const decimal FallbackPace = 200m;

    public async Task<LibraryShelvesDto> GetShelvesAsync(Guid userId, Guid siteId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var recentCutoff = now.AddDays(-RecentlyAddedDays);
        var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);

        var pace = await ComputeUserPaceAsync(userId, ct);

        var continueReading = await GetContinueReadingAsync(userId, siteId, pace, ct);
        var recentlyAdded = await GetRecentlyAddedAsync(userId, siteId, recentCutoff, pace, ct);
        var quickReads = await GetQuickReadsAsync(userId, siteId, pace, ct);
        var finishedThisMonth = await GetFinishedThisMonthAsync(userId, siteId, monthStart, ct);

        return new LibraryShelvesDto(continueReading, recentlyAdded, quickReads, finishedThisMonth);
    }

    private async Task<decimal> ComputeUserPaceAsync(Guid userId, CancellationToken ct)
    {
        var sessions = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.DurationSeconds > 0)
            .Select(s => new { s.DurationSeconds, s.WordsRead })
            .ToListAsync(ct);

        if (sessions.Count == 0) return FallbackPace;

        var totalMinutes = sessions.Sum(s => (long)s.DurationSeconds) / 60m;
        var totalWords = sessions.Sum(s => s.WordsRead);
        if (totalMinutes <= 0) return FallbackPace;

        var pace = totalWords / totalMinutes;
        return pace >= MinSanePace ? pace : FallbackPace;
    }

    private async Task<IReadOnlyList<LibraryShelfItemDto>> GetContinueReadingAsync(
        Guid userId, Guid siteId, decimal pace, CancellationToken ct)
    {
        var uploads = await db.UserBooks
            .Where(b => b.UserId == userId
                && b.TakedownAt == null
                && b.ProgressPercent != null
                && b.ProgressPercent > InProgressMinPercent
                && b.ProgressPercent < InProgressMaxPercent
                && b.CompletedAt == null)
            .OrderByDescending(b => b.ProgressUpdatedAt)
            .Take(ShelfLimit * 2)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Author,
                b.CoverPath,
                b.Slug,
                b.Language,
                Progress = b.ProgressPercent ?? 0,
                b.ProgressChapterSlug,
                b.ProgressLocator,
                b.ProgressPositionJson,
                LastOpened = b.ProgressUpdatedAt,
                b.CreatedAt,
                b.TotalWordCount
            })
            .ToListAsync(ct);

        var savedQuery =
            from ul in db.UserLibraries
            where ul.UserId == userId
            join e in db.Editions on ul.EditionId equals e.Id
            let latestProgress = db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == e.Id)
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p => new { p.Percent, p.UpdatedAt, p.ChapterId, p.Locator, p.PositionJson, p.CompletedAt })
                .FirstOrDefault()
            where latestProgress != null
                && latestProgress.Percent != null
                && latestProgress.Percent > InProgressMinPercent
                && latestProgress.Percent < InProgressMaxPercent
                && latestProgress.CompletedAt == null
            orderby latestProgress.UpdatedAt descending
            select new
            {
                e.Id,
                e.Title,
                Author = (string?)e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .FirstOrDefault(),
                e.CoverPath,
                e.Slug,
                e.Language,
                Progress = latestProgress.Percent ?? 0,
                CurrentChapterId = (Guid?)latestProgress.ChapterId,
                // Resolved here rather than by the caller: the id is useless to a client, and a
                // second round trip per book is what this shelf existed to avoid.
                CurrentChapterSlug = db.Chapters
                    .Where(c => c.Id == latestProgress.ChapterId)
                    .Select(c => c.Slug)
                    .FirstOrDefault(),
                CurrentLocator = latestProgress.Locator,
                CurrentPositionJson = latestProgress.PositionJson,
                LastOpened = (DateTimeOffset?)latestProgress.UpdatedAt,
                ul.CreatedAt,
                TotalWordCount = (int?)db.Chapters
                    .Where(c => c.EditionId == e.Id)
                    .Sum(c => (int?)c.WordCount ?? 0)
            };

        var saved = await savedQuery.Take(ShelfLimit * 2).ToListAsync(ct);

        // Both kinds now store a book-wide percent, so both are used verbatim —
        // the same value the library card path returns, so card and shelf agree.
        // Editions used to store a chapter fraction here, which this service then
        // re-expanded against prior-chapter word counts. Web had already been
        // writing a book fraction into that column, so its rows were counted twice.

        var merged = uploads
            .Select(u =>
            {
                var p = Math.Clamp(u.Progress, 0.0, 1.0);
                return new LibraryShelfItemDto(
                    u.Id, "userbook", u.Title, u.Author, u.CoverPath, u.Slug, u.Language,
                    p, u.LastOpened, u.CreatedAt,
                    EstimateRemaining(u.TotalWordCount, p, pace),
                    u.ProgressLocator, u.ProgressPositionJson, u.ProgressChapterSlug);
            })
            .Concat(saved.Select(s =>
            {
                var p = Math.Clamp(s.Progress, 0.0, 1.0);
                return new LibraryShelfItemDto(
                    s.Id, "savedbook", s.Title, s.Author, s.CoverPath, s.Slug, s.Language,
                    p, s.LastOpened, s.CreatedAt,
                    EstimateRemaining(s.TotalWordCount, p, pace),
                    s.CurrentLocator, s.CurrentPositionJson, s.CurrentChapterSlug);
            }))
            .OrderByDescending(i => i.LastOpenedAt ?? DateTimeOffset.MinValue)
            .Take(ShelfLimit)
            .ToList();

        return merged;
    }

    private async Task<IReadOnlyList<LibraryShelfItemDto>> GetRecentlyAddedAsync(
        Guid userId, Guid siteId, DateTimeOffset cutoff, decimal pace, CancellationToken ct)
    {
        var uploads = await db.UserBooks
            .Where(b => b.UserId == userId
                && b.TakedownAt == null
                && b.CreatedAt >= cutoff)
            .OrderByDescending(b => b.CreatedAt)
            .Take(ShelfLimit * 2)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Author,
                b.CoverPath,
                b.Slug,
                b.Language,
                Progress = b.ProgressPercent ?? 0,
                b.ProgressChapterSlug,
                b.ProgressLocator,
                b.ProgressPositionJson,
                LastOpened = b.ProgressUpdatedAt,
                b.CreatedAt,
                b.TotalWordCount
            })
            .ToListAsync(ct);

        var saved = await (
            from ul in db.UserLibraries
            where ul.UserId == userId && ul.CreatedAt >= cutoff
            join e in db.Editions on ul.EditionId equals e.Id
            let latest = db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == e.Id)
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p => new { p.Percent, p.UpdatedAt, p.ChapterId, p.Locator, p.PositionJson })
                .FirstOrDefault()
            orderby ul.CreatedAt descending
            select new
            {
                e.Id,
                e.Title,
                Author = (string?)e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .FirstOrDefault(),
                e.CoverPath,
                e.Slug,
                e.Language,
                ul.CreatedAt,
                LatestProgress = latest != null ? latest.Percent : null,
                CurrentChapterId = latest != null ? (Guid?)latest.ChapterId : null,
                CurrentChapterSlug = latest != null
                    ? db.Chapters.Where(c => c.Id == latest.ChapterId).Select(c => c.Slug).FirstOrDefault()
                    : null,
                CurrentLocator = latest != null ? latest.Locator : null,
                CurrentPositionJson = latest != null ? latest.PositionJson : null,
                LastOpened = latest != null ? (DateTimeOffset?)latest.UpdatedAt : null,
                TotalWordCount = (int?)db.Chapters
                    .Where(c => c.EditionId == e.Id)
                    .Sum(c => (int?)c.WordCount ?? 0)
            }).Take(ShelfLimit * 2).ToListAsync(ct);

        return uploads
            .Select(u =>
            {
                var p = Math.Clamp(u.Progress, 0.0, 1.0);
                return new LibraryShelfItemDto(
                    u.Id, "userbook", u.Title, u.Author, u.CoverPath, u.Slug, u.Language,
                    p, u.LastOpened, u.CreatedAt,
                    EstimateRemaining(u.TotalWordCount, p, pace),
                    u.ProgressLocator, u.ProgressPositionJson, u.ProgressChapterSlug);
            })
            .Concat(saved.Select(s =>
            {
                var p = Math.Clamp(s.LatestProgress ?? 0, 0.0, 1.0);
                return new LibraryShelfItemDto(
                    s.Id, "savedbook", s.Title, s.Author, s.CoverPath, s.Slug, s.Language,
                    p, s.LastOpened, s.CreatedAt,
                    EstimateRemaining(s.TotalWordCount, p, pace),
                    s.CurrentLocator, s.CurrentPositionJson, s.CurrentChapterSlug);
            }))
            .OrderByDescending(i => i.CreatedAt)
            .Take(ShelfLimit)
            .ToList();
    }

    private async Task<IReadOnlyList<LibraryShelfItemDto>> GetQuickReadsAsync(
        Guid userId, Guid siteId, decimal pace, CancellationToken ct)
    {
        if (pace < MinSanePace) return Array.Empty<LibraryShelfItemDto>();

        var uploads = await db.UserBooks
            .Where(b => b.UserId == userId
                && b.TakedownAt == null
                && b.CompletedAt == null
                && b.TotalWordCount != null
                && b.TotalWordCount > 0
                && (b.ProgressPercent ?? 0) < InProgressMaxPercent)
            .OrderBy(b => b.TotalWordCount)
            .Take(ShelfLimit * 4)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Author,
                b.CoverPath,
                b.Slug,
                b.Language,
                Progress = b.ProgressPercent ?? 0,
                b.ProgressChapterSlug,
                b.ProgressLocator,
                b.ProgressPositionJson,
                LastOpened = b.ProgressUpdatedAt,
                b.CreatedAt,
                b.TotalWordCount
            })
            .ToListAsync(ct);

        var saved = await (
            from ul in db.UserLibraries
            where ul.UserId == userId
            join e in db.Editions on ul.EditionId equals e.Id
            let totalWords = db.Chapters
                .Where(c => c.EditionId == e.Id)
                .Sum(c => (int?)c.WordCount ?? 0)
            let latest = db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == e.Id)
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p => new { p.Percent, p.UpdatedAt, p.ChapterId, p.Locator, p.PositionJson })
                .FirstOrDefault()
            where totalWords > 0 && ((latest != null ? latest.Percent : null) ?? 0) < InProgressMaxPercent
            orderby totalWords
            select new
            {
                e.Id,
                e.Title,
                Author = (string?)e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .FirstOrDefault(),
                e.CoverPath,
                e.Slug,
                e.Language,
                Progress = (latest != null ? latest.Percent : null) ?? 0,
                CurrentChapterId = latest != null ? (Guid?)latest.ChapterId : null,
                CurrentChapterSlug = latest != null
                    ? db.Chapters.Where(c => c.Id == latest.ChapterId).Select(c => c.Slug).FirstOrDefault()
                    : null,
                CurrentLocator = latest != null ? latest.Locator : null,
                CurrentPositionJson = latest != null ? latest.PositionJson : null,
                LastOpened = latest != null ? (DateTimeOffset?)latest.UpdatedAt : null,
                ul.CreatedAt,
                TotalWordCount = (int?)totalWords
            }).Take(ShelfLimit * 4).ToListAsync(ct);

        // User books store book-wide ProgressPercent verbatim (see GetContinueReadingAsync).
        bool IsQuick(int? words, double progress)
        {
            if (words is null or <= 0) return false;
            var remaining = EstimateRemaining(words, progress, pace);
            return remaining is > 0 and <= QuickReadMaxMinutes;
        }

        return uploads
            .Select(u => (Item: u, Pct: Math.Clamp(u.Progress, 0.0, 1.0)))
            .Where(x => IsQuick(x.Item.TotalWordCount, x.Pct))
            .Select(x => new LibraryShelfItemDto(
                x.Item.Id, "userbook", x.Item.Title, x.Item.Author, x.Item.CoverPath, x.Item.Slug, x.Item.Language,
                x.Pct, x.Item.LastOpened, x.Item.CreatedAt,
                EstimateRemaining(x.Item.TotalWordCount, x.Pct, pace),
                x.Item.ProgressLocator, x.Item.ProgressPositionJson))
            .Concat(saved
                .Select(s => (Item: s, Pct: Math.Clamp(s.Progress, 0.0, 1.0)))
                .Where(x => IsQuick(x.Item.TotalWordCount, x.Pct))
                .Select(x => new LibraryShelfItemDto(
                    x.Item.Id, "savedbook", x.Item.Title, x.Item.Author, x.Item.CoverPath, x.Item.Slug, x.Item.Language,
                    x.Pct, x.Item.LastOpened, x.Item.CreatedAt,
                    EstimateRemaining(x.Item.TotalWordCount, x.Pct, pace),
                    x.Item.CurrentLocator, x.Item.CurrentPositionJson)))
            .OrderBy(i => i.EstimatedMinutesRemaining ?? int.MaxValue)
            .Take(ShelfLimit)
            .ToList();
    }

    private async Task<IReadOnlyList<LibraryShelfItemDto>> GetFinishedThisMonthAsync(
        Guid userId, Guid siteId, DateTimeOffset monthStart, CancellationToken ct)
    {
        var uploads = await db.UserBooks
            .Where(b => b.UserId == userId
                && b.TakedownAt == null
                && b.CompletedAt != null
                && b.CompletedAt >= monthStart)
            .OrderByDescending(b => b.CompletedAt)
            .Take(ShelfLimit * 2)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Author,
                b.CoverPath,
                b.Slug,
                b.Language,
                FinishedAt = b.CompletedAt!.Value,
                b.CreatedAt
            })
            .ToListAsync(ct);

        var saved = await (
            from ul in db.UserLibraries
            where ul.UserId == userId
            join e in db.Editions on ul.EditionId equals e.Id
            let latest = db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == e.Id)
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p => new { p.Percent, p.UpdatedAt, p.CompletedAt })
                .FirstOrDefault()
            where latest != null
                && latest.CompletedAt != null
                && latest.CompletedAt >= monthStart
            orderby latest.CompletedAt descending
            select new
            {
                e.Id,
                e.Title,
                Author = (string?)e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .FirstOrDefault(),
                e.CoverPath,
                e.Slug,
                e.Language,
                FinishedAt = latest.UpdatedAt,
                ul.CreatedAt
            }).Take(ShelfLimit * 2).ToListAsync(ct);

        return uploads
            .Select(u => new LibraryShelfItemDto(
                u.Id, "userbook", u.Title, u.Author, u.CoverPath, u.Slug, u.Language,
                1.0, u.FinishedAt, u.CreatedAt, null))
            .Concat(saved.Select(s => new LibraryShelfItemDto(
                s.Id, "savedbook", s.Title, s.Author, s.CoverPath, s.Slug, s.Language,
                1.0, s.FinishedAt, s.CreatedAt, null)))
            .OrderByDescending(i => i.LastOpenedAt ?? DateTimeOffset.MinValue)
            .Take(ShelfLimit)
            .ToList();
    }


    public static int? EstimateRemaining(int? totalWords, double progress, decimal pace)
    {
        if (pace < MinSanePace) return null;
        if (totalWords is null or <= 0) return null;
        var clampedProgress = Math.Clamp(progress, 0.0, 1.0);
        var wordsLeft = (decimal)(totalWords.Value * (1 - clampedProgress));
        if (wordsLeft <= 0) return 0;
        return (int)Math.Ceiling(wordsLeft / pace);
    }
}
