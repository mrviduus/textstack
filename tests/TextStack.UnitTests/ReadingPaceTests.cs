using Application.ReadingTracking;

namespace TextStack.UnitTests;

/// <summary>The one server pace rule — shelves, book stats, /me/reading/pace and /stats all use it.</summary>
public class ReadingPaceTests
{
    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(2, 10_000, 600)]   // enough words, too few sessions
    [InlineData(5, 1000, 0)]       // sessions but no seconds
    public void FromTotals_NotEnoughHistory_Returns200NotUserSpecific(int sessions, long words, long seconds)
    {
        var p = ReadingPace.FromTotals(sessions, words, seconds);

        Assert.Equal(ReadingPace.FallbackWpm, p.Wpm);
        Assert.Equal(sessions, p.SessionCount);
        Assert.False(p.IsUserSpecific);
    }

    [Fact]
    public void FromTotals_EnoughHistory_RoundsPersonalPace()
    {
        // 1000 words in 190 s = 315.79 wpm.
        var p = ReadingPace.FromTotals(3, 1000, 190);

        Assert.Equal(316, p.Wpm);
        Assert.True(p.IsUserSpecific);
    }

    [Theory]
    [InlineData(10, 60, 50)]        // 10 wpm → floor
    [InlineData(100_000, 60, 800)]  // 100k wpm → ceiling
    public void FromTotals_OutOfRange_Clamps(long words, long seconds, int expected) =>
        Assert.Equal(expected, ReadingPace.FromTotals(3, words, seconds).Wpm);

    [Theory]
    [InlineData(10_000, 0.5, 200, 25)]
    [InlineData(1000, 0.0, 400, 3)]    // 2.5 → 3 (half away from zero, like JS Math.round)
    [InlineData(1000, 0.0, 300, 3)]    // 3.33 → 3 (nearest, not ceiling)
    [InlineData(1000, 1.0, 200, 0)]
    [InlineData(1000, 1.5, 200, 0)]    // progress clamped
    [InlineData(1000, -1.0, 200, 5)]
    public void MinutesLeft_RoundsToNearest(int words, double progress, int wpm, int expected) =>
        Assert.Equal(expected, ReadingPace.MinutesLeft(words, progress, wpm));

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(-5)]
    public void MinutesLeft_NoWordCount_ReturnsNull(int? words) =>
        Assert.Null(ReadingPace.MinutesLeft(words, 0.5, 200));
}
