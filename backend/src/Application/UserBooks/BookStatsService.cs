using Application.Common.Interfaces;
using Application.ReadingTracking;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class BookStatsService(IAppDbContext db)
{
    public async Task<BookStatsResult?> GetStatsAsync(Guid userId, Guid userBookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Where(b => b.Id == userBookId && b.UserId == userId)
            .Select(b => new { b.Id, b.TotalWordCount, b.ProgressPercent })
            .FirstOrDefaultAsync(ct);
        if (book is null) return null;

        // Aggregated in SQL — the session rows are never materialised.
        var sessions = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.UserBookId == userBookId)
            .GroupBy(_ => 1)
            .Select(g => new { Count = g.Count(), Seconds = g.Sum(s => (long)s.DurationSeconds), Words = g.Sum(s => s.WordsRead) })
            .FirstOrDefaultAsync(ct);

        var vocabCount = await db.VocabularyWords
            .CountAsync(v => v.UserId == userId && v.UserBookId == userBookId, ct);
        var highlightsCount = await db.Highlights
            .CountAsync(h => h.UserId == userId && h.UserBookId == userBookId, ct);

        var pace = await ReadingPace.GetAsync(db, userId, ct);
        var minutesLeft = ReadingPace.MinutesLeft(book.TotalWordCount, book.ProgressPercent ?? 0, pace.Wpm);

        return new BookStatsResult(
            BookId: book.Id,
            SessionsCount: sessions?.Count ?? 0,
            TotalReadMinutes: (sessions?.Seconds ?? 0) / 60,
            WordsRead: sessions?.Words ?? 0,
            VocabSavedCount: vocabCount,
            HighlightsCount: highlightsCount,
            // Displayed, so measured: this book's own average, 0 with no sessions. The pace rule
            // (fallback 200) is only for the estimate below.
            AverageWordsPerMinute: sessions is { Seconds: > 0 }
                ? Math.Round(sessions.Words / (sessions.Seconds / 60m), 1)
                : 0m,
            // Null once nothing is left, as before — a finished book has no estimate.
            EstimatedMinutesRemaining: minutesLeft is > 0 ? minutesLeft : null
        );
    }
}

public record BookStatsResult(
    Guid BookId,
    int SessionsCount,
    long TotalReadMinutes,
    int WordsRead,
    int VocabSavedCount,
    int HighlightsCount,
    decimal AverageWordsPerMinute,
    int? EstimatedMinutesRemaining
);
