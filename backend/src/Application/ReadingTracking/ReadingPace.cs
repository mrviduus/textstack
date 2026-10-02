using Application.Common.Interfaces;
using Contracts.ReadingTracking;
using Microsoft.EntityFrameworkCore;

namespace Application.ReadingTracking;

/// <summary>
/// The one reading-pace rule on the server: the reader's own words-per-minute once there are
/// <see cref="MinSessions"/> sessions to measure, otherwise <see cref="FallbackWpm"/>. Used by
/// <c>/me/reading/pace</c>, <c>/me/reading/stats</c>, book stats and the library shelves, so every
/// "minutes left" agrees. Mirrors <c>packages/shared/src/reader/readingTime.ts</c>.
/// </summary>
public static class ReadingPace
{
    public const int FallbackWpm = 200;
    public const int MinSessions = 3;
    // Guards against ultra-short sessions skewing the average.
    private const int MinWpm = 50;
    private const int MaxWpm = 800;

    /// <summary>One aggregate query over the user's sessions — never materialises them.</summary>
    public static async Task<ReadingPaceDto> GetAsync(IAppDbContext db, Guid userId, CancellationToken ct)
    {
        var agg = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.WordsRead > 0 && s.DurationSeconds > 0)
            .GroupBy(_ => 1)
            .Select(g => new { Sessions = g.Count(), Words = g.Sum(s => (long)s.WordsRead), Seconds = g.Sum(s => (long)s.DurationSeconds) })
            .FirstOrDefaultAsync(ct);

        return agg is null
            ? FromTotals(0, 0, 0)
            : FromTotals(agg.Sessions, agg.Words, agg.Seconds);
    }

    public static ReadingPaceDto FromTotals(int sessions, long words, long seconds)
    {
        if (sessions < MinSessions || seconds <= 0)
            return new ReadingPaceDto(FallbackWpm, sessions, false);

        var wpm = (int)Math.Round(words / (seconds / 60.0));
        return new ReadingPaceDto(Math.Clamp(wpm, MinWpm, MaxWpm), sessions, true);
    }

    /// <summary>
    /// Minutes left in a book, rounded to nearest (same as the clients' <c>Math.round</c>).
    /// Null when the book has no word count.
    /// </summary>
    public static int? MinutesLeft(int? totalWords, double progress, int wpm)
    {
        if (totalWords is null or <= 0 || wpm <= 0) return null;
        var wordsLeft = totalWords.Value * (1 - Math.Clamp(progress, 0.0, 1.0));
        return (int)Math.Round(wordsLeft / wpm, MidpointRounding.AwayFromZero);
    }
}
