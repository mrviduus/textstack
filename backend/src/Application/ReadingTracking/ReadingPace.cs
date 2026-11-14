using Application.Common.Interfaces;
using Contracts.ReadingTracking;
using Microsoft.EntityFrameworkCore;

namespace Application.ReadingTracking;

/// <summary>
/// The one reading-pace rule on the server: the reader's own words-per-minute once there are
/// <see cref="MinSessions"/> sessions to measure, otherwise <see cref="FallbackWpm"/>. Used by
/// <c>/me/reading/pace</c>, <c>/me/reading/stats</c>, book stats and the library shelves, so every
/// "minutes left" agrees. Mirrors <c>packages/shared/src/reader/readingTime.ts</c>. Counts the V2 reader's
/// sessions too (#1313, <see cref="IV2PaceTotals"/>), whenever V2 answers.
/// </summary>
public static class ReadingPace
{
    public const int FallbackWpm = 200;
    public const int MinSessions = 3;
    // Guards against ultra-short sessions skewing the average.
    private const int MinWpm = 50;
    private const int MaxWpm = 800;

    /// <summary>One aggregate query over the user's sessions — never materialises them — plus V2's own (<paramref name="v2"/>).</summary>
    public static async Task<ReadingPaceDto> GetAsync(IAppDbContext db, Guid userId, CancellationToken ct, IV2PaceTotals? v2 = null)
    {
        var agg = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.WordsRead > 0 && s.DurationSeconds > 0)
            .GroupBy(_ => 1)
            .Select(g => new { Sessions = g.Count(), Words = g.Sum(s => (long)s.WordsRead), Seconds = g.Sum(s => (long)s.DurationSeconds) })
            .FirstOrDefaultAsync(ct);

        var more = v2 is null ? default : await v2.GetAsync(userId, ct);
        return FromTotals((agg?.Sessions ?? 0) + more.Sessions, (agg?.Words ?? 0) + more.Words, (agg?.Seconds ?? 0) + more.Seconds);
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

/// <summary>The pace rule's sums: sessions with words and seconds, their words, their seconds.</summary>
public readonly record struct PaceTotals(int Sessions, long Words, long Seconds);

/// <summary>
/// The V2 reader's sessions for the pace (#1313; they live in <c>textstack_v2</c>). Legacy never depends on V2
/// being up: off, not ready or failing, the answer is no sessions.
/// </summary>
public interface IV2PaceTotals
{
    Task<PaceTotals> GetAsync(Guid userId, CancellationToken ct);
}
