using Application.Reading;

namespace TextStack.UnitTests.Reading;

/// <summary>
/// The stats of #1366 on a fixed today, Wednesday 2026-11-25: calendar buckets, minutes that add up, and streaks — a run of
/// days read; today may still be ahead, so a run ending yesterday is still current.
/// </summary>
public class ReadingStatsTests
{
    private static readonly DateOnly Today = new(2026, 11, 25);

    private static DateOnly[] DaysAgo(params int[] ago) => [.. ago.OrderDescending().Select(a => Today.AddDays(-a))];

    [Fact]
    public void Streaks_NoDays_AreZero() => Assert.Equal((0, 0), ReadingStats.Streaks([], Today));

    [Fact]
    public void Streaks_RunEndingToday_CountsToday() => Assert.Equal((3, 3), ReadingStats.Streaks(DaysAgo(0, 1, 2), Today));

    [Fact]
    public void Streaks_RunEndingYesterday_IsStillCurrent() => Assert.Equal((2, 2), ReadingStats.Streaks(DaysAgo(1, 2), Today));

    [Fact]
    public void Streaks_LastReadTwoDaysAgo_CurrentIsZero() => Assert.Equal((0, 2), ReadingStats.Streaks(DaysAgo(2, 3), Today));

    [Fact]
    public void Streaks_LongerRunEarlier_IsTheBest() => Assert.Equal((1, 4), ReadingStats.Streaks(DaysAgo(0, 10, 11, 12, 13, 20), Today));

    [Fact]
    public void Streaks_RunAcrossAMonthAndYearEnd_IsOneRun() =>
        Assert.Equal((0, 3), ReadingStats.Streaks([new(2025, 12, 31), new(2026, 1, 1), new(2026, 1, 2)], Today));

    private static DailyReading Read(int month, int day, long seconds) => new(new DateOnly(2026, month, day), seconds);

    [Fact]
    public void Build_Week_IsMondayToSundayWithZeros()
    {
        var stats = ReadingStats.Build("week", Today, [Read(11, 22, 600), Read(11, 23, 1200), Read(11, 25, 300)]);

        Assert.Equal((new DateOnly(2026, 11, 23), new DateOnly(2026, 11, 29)), (stats.From, stats.To));
        Assert.Equal([20, 0, 5, 0, 0, 0, 0], stats.Bars.Select(b => b.Minutes));
        Assert.Equal((25, 2), (stats.Minutes, stats.DaysRead));
    }

    [Fact]
    public void Build_Halfyear_IsThisMonthAndTheFiveBefore()
    {
        var stats = ReadingStats.Build("halfyear", Today, [Read(5, 31, 600), Read(6, 1, 600), Read(6, 30, 600), Read(11, 25, 60)]);

        Assert.Equal((new DateOnly(2026, 6, 1), new DateOnly(2026, 11, 30)), (stats.From, stats.To));
        Assert.Equal([(6, 20), (7, 0), (8, 0), (9, 0), (10, 0), (11, 1)], stats.Bars.Select(b => (b.Start.Month, b.Minutes)));
        Assert.All(stats.Bars, b => Assert.Equal(1, b.Start.Day));
    }

    [Fact]
    public void Build_HalfyearInMarch_ReachesIntoLastYear()
    {
        var stats = ReadingStats.Build("halfyear", new DateOnly(2026, 3, 9), []);

        Assert.Equal((new DateOnly(2025, 10, 1), new DateOnly(2026, 3, 31), 6), (stats.From, stats.To, stats.Bars.Count));
    }

    [Fact]
    public void Build_Year_IsTwelveMonthBars() =>
        Assert.Equal([new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 1)],
            new[] { 0, 11 }.Select(i => ReadingStats.Build("year", Today, []).Bars[i].Start));

    [Fact]
    public void Build_HalfMinutesOnTwoDays_TotalIsTheSumOfTheRoundedBars()
    {
        var stats = ReadingStats.Build("week", Today, [Read(11, 23, 30), Read(11, 24, 30)]);

        Assert.Equal([1, 1], stats.Bars.Take(2).Select(b => b.Minutes));
        Assert.Equal(2, stats.Minutes);
    }

    [Fact]
    public void Build_MoreMinutesThanAnInt_ClampsToIntMax()
    {
        var huge = int.MaxValue * 60L;
        var stats = ReadingStats.Build("week", Today, [Read(11, 23, huge), Read(11, 24, huge)]);

        Assert.Equal((int.MaxValue, int.MaxValue), (stats.Bars[0].Minutes, stats.Minutes));
    }
}
