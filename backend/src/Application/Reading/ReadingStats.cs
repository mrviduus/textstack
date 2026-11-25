using Contracts.Sync;

namespace Application.Reading;

/// <summary>The stats of #1366 from a user's daily totals: a calendar period's buckets and the all-time streaks.</summary>
public static class ReadingStats
{
    public static bool IsPeriod(string? period) => period is "week" or "month" or "halfyear" or "year";

    /// <param name="days">Ascending, one per day read (<see cref="IReadingSessionRepository.DailyTotalsAsync"/>).</param>
    public static ReadingStatsDto Build(string period, DateOnly today, IReadOnlyList<DailyReading> days)
    {
        var month = new DateOnly(today.Year, today.Month, 1);
        var (from, to) = period switch
        {
            "week" => (today.AddDays(-(((int)today.DayOfWeek + 6) % 7)), today.AddDays(6 - (((int)today.DayOfWeek + 6) % 7))),
            "month" => (month, month.AddMonths(1).AddDays(-1)),
            "halfyear" => (month.AddMonths(-5), month.AddMonths(1).AddDays(-1)),
            "year" => (new DateOnly(today.Year, 1, 1), new DateOnly(today.Year, 12, 31)),
            _ => throw new ArgumentOutOfRangeException(nameof(period), period, "Not a stats period."),
        };
        var daily = period is "week" or "month";
        DateOnly BucketOf(DateOnly day) => daily ? day : new DateOnly(day.Year, day.Month, 1);

        var inPeriod = days.Where(d => d.Day >= from && d.Day <= to).ToList();
        var seconds = inPeriod.GroupBy(d => BucketOf(d.Day)).ToDictionary(g => g.Key, g => g.Sum(d => d.Seconds));
        var bars = new List<ReadingStatsBarDto>();
        for (var start = from; start <= to; start = daily ? start.AddDays(1) : start.AddMonths(1))
            bars.Add(new(start, Minutes(seconds.GetValueOrDefault(start))));

        var (current, best) = Streaks([.. days.Select(d => d.Day)], today);
        return new(period, from, to, Minutes(inPeriod.Sum(d => d.Seconds)), inPeriod.Count, current, best, bars);
    }

    /// <summary>
    /// <paramref name="days"/> ascending and distinct. Current: the run ending today, or yesterday while today has none yet; best: the longest run.
    /// </summary>
    public static (int Current, int Best) Streaks(IReadOnlyList<DateOnly> days, DateOnly today)
    {
        int best = 0, run = 0;
        for (var i = 0; i < days.Count; i++)
        {
            run = i > 0 && days[i - 1].AddDays(1) == days[i] ? run + 1 : 1;
            best = Math.Max(best, run);
        }
        var read = days.ToHashSet();
        var current = 0;
        for (var day = read.Contains(today) ? today : today.AddDays(-1); read.Contains(day); day = day.AddDays(-1)) current++;
        return (current, best);
    }

    private static int Minutes(long seconds) => (int)Math.Round(seconds / 60.0, MidpointRounding.AwayFromZero);
}
