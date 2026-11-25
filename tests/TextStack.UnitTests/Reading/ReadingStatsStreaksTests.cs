using Application.Reading;

namespace TextStack.UnitTests.Reading;

/// <summary>Streaks (#1366): a run of days read; today may still be ahead, so a run ending yesterday is still current.</summary>
public class ReadingStatsStreaksTests
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
}
