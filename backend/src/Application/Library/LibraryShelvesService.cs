using Application.Common.Interfaces;
using Application.ReadingTracking;
using Contracts.Library;
using Microsoft.EntityFrameworkCore;

namespace Application.Library;

/// <summary>
/// The four library shelves. Three round trips — pace (one aggregate), the reader's uploads and the
/// reader's saved editions — and the shelves are cut from those two lists in memory. It used to be
/// nine sequential queries plus a read of every reading-session row to compute the pace.
/// <para>
/// Both lists are the reader's whole library (light columns only — no chapter text). A library is
/// tens of books, not thousands; the quick-reads shelf already had to look at all of it.
/// </para>
/// </summary>
public class LibraryShelvesService(IAppDbContext db)
{
    private const int ShelfLimit = 10;
    private const int RecentlyAddedDays = 14;
    private const int QuickReadMaxMinutes = 60;
    private const double InProgressMinPercent = 0.0;
    private const double InProgressMaxPercent = 0.95;

    private sealed record Upload(
        Guid Id, string Title, string? Author, string? CoverPath, string Slug, string Language,
        double? Progress, string? ChapterSlug, string? Locator, string? PositionJson,
        DateTimeOffset? LastOpened, DateTimeOffset CreatedAt, DateTimeOffset? CompletedAt, int? TotalWordCount);

    private sealed record Saved(
        Guid Id, string Title, string? Author, string? CoverPath, string Slug, string Language,
        double? Progress, string? ChapterSlug, string? Locator, string? PositionJson,
        DateTimeOffset? LastOpened, DateTimeOffset? CompletedAt, DateTimeOffset CreatedAt, int TotalWordCount);

    public async Task<LibraryShelvesDto> GetShelvesAsync(Guid userId, Guid siteId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var recentCutoff = now.AddDays(-RecentlyAddedDays);
        var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);

        var pace = (await ReadingPace.GetAsync(db, userId, ct)).Wpm;

        var uploads = await db.UserBooks
            .Where(b => b.UserId == userId && b.TakedownAt == null)
            .Select(b => new Upload(
                b.Id, b.Title, b.Author, b.CoverPath, b.Slug, b.Language,
                b.ProgressPercent, b.ProgressChapterSlug, b.ProgressLocator, b.ProgressPositionJson,
                b.ProgressUpdatedAt, b.CreatedAt, b.CompletedAt, b.TotalWordCount))
            .ToListAsync(ct);

        var saved = await (
            from ul in db.UserLibraries
            where ul.UserId == userId
            join e in db.Editions on ul.EditionId equals e.Id
            let latest = db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == e.Id)
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p => new { p.Percent, p.UpdatedAt, p.ChapterId, p.Locator, p.PositionJson, p.CompletedAt })
                .FirstOrDefault()
            select new Saved(
                e.Id,
                e.Title,
                e.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name).FirstOrDefault(),
                e.CoverPath,
                e.Slug,
                e.Language,
                latest != null ? latest.Percent : null,
                // Resolved here rather than by the caller: the id is useless to a client.
                latest != null
                    ? db.Chapters.Where(c => c.Id == latest.ChapterId).Select(c => c.Slug).FirstOrDefault()
                    : null,
                latest != null ? latest.Locator : null,
                latest != null ? latest.PositionJson : null,
                latest != null ? (DateTimeOffset?)latest.UpdatedAt : null,
                latest != null ? latest.CompletedAt : null,
                ul.CreatedAt,
                db.Chapters.Where(c => c.EditionId == e.Id).Sum(c => (int?)c.WordCount ?? 0))
        ).ToListAsync(ct);

        // Both kinds store a book-wide percent, used verbatim — the same value the library card
        // path returns, so card and shelf agree.
        LibraryShelfItemDto FromUpload(Upload u)
        {
            var p = Math.Clamp(u.Progress ?? 0, 0.0, 1.0);
            return new LibraryShelfItemDto(
                u.Id, "userbook", u.Title, u.Author, u.CoverPath, u.Slug, u.Language,
                p, u.LastOpened, u.CreatedAt, ReadingPace.MinutesLeft(u.TotalWordCount, p, pace),
                u.Locator, u.PositionJson, u.ChapterSlug);
        }

        LibraryShelfItemDto FromSaved(Saved s)
        {
            var p = Math.Clamp(s.Progress ?? 0, 0.0, 1.0);
            return new LibraryShelfItemDto(
                s.Id, "savedbook", s.Title, s.Author, s.CoverPath, s.Slug, s.Language,
                p, s.LastOpened, s.CreatedAt, ReadingPace.MinutesLeft(s.TotalWordCount, p, pace),
                s.Locator, s.PositionJson, s.ChapterSlug);
        }

        static bool InProgress(double? p) => p is > InProgressMinPercent and < InProgressMaxPercent;

        var continueReading = uploads
            .Where(u => InProgress(u.Progress) && u.CompletedAt == null)
            .Select(FromUpload)
            .Concat(saved.Where(s => InProgress(s.Progress) && s.CompletedAt == null).Select(FromSaved))
            .OrderByDescending(i => i.LastOpenedAt ?? DateTimeOffset.MinValue)
            .Take(ShelfLimit)
            .ToList();

        var recentlyAdded = uploads
            .Where(u => u.CreatedAt >= recentCutoff)
            .Select(FromUpload)
            .Concat(saved.Where(s => s.CreatedAt >= recentCutoff).Select(FromSaved))
            .OrderByDescending(i => i.CreatedAt)
            .Take(ShelfLimit)
            .ToList();

        // Candidates are the shortest 40 of each kind (as the SQL used to pick), then filtered.
        var quickReads = uploads
            .Where(u => u.CompletedAt == null && u.TotalWordCount > 0 && (u.Progress ?? 0) < InProgressMaxPercent)
            .OrderBy(u => u.TotalWordCount)
            .Take(ShelfLimit * 4)
            .Select(FromUpload)
            .Concat(saved
                .Where(s => s.TotalWordCount > 0 && (s.Progress ?? 0) < InProgressMaxPercent)
                .OrderBy(s => s.TotalWordCount)
                .Take(ShelfLimit * 4)
                .Select(FromSaved))
            .Where(i => i.EstimatedMinutesRemaining is > 0 and <= QuickReadMaxMinutes)
            .OrderBy(i => i.EstimatedMinutesRemaining)
            .Take(ShelfLimit)
            .ToList();

        var finishedThisMonth = uploads
            .Where(u => u.CompletedAt >= monthStart)
            .OrderByDescending(u => u.CompletedAt)
            .Take(ShelfLimit * 2)
            .Select(u => FromUpload(u) with { ProgressPercent = 1.0, LastOpenedAt = u.CompletedAt, EstimatedMinutesRemaining = null })
            .Concat(saved
                .Where(s => s.CompletedAt >= monthStart)
                .OrderByDescending(s => s.CompletedAt)
                .Take(ShelfLimit * 2)
                .Select(s => FromSaved(s) with { ProgressPercent = 1.0, EstimatedMinutesRemaining = null }))
            .OrderByDescending(i => i.LastOpenedAt ?? DateTimeOffset.MinValue)
            .Take(ShelfLimit)
            .ToList();

        return new LibraryShelvesDto(continueReading, recentlyAdded, quickReads, finishedThisMonth);
    }
}
