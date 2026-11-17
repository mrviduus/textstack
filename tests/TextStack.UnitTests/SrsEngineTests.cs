using TextStack.Vocabulary;

namespace TextStack.UnitTests;

public class SrsEngineTests
{
    private readonly ISrsEngine _srs = new SrsEngine();

    // Calculate(stage, consecutiveCorrect, currentInterval, isCorrect)
    //   → (newStage, newInterval, newConsecutive)
    [Theory]
    // Correct → stage progression
    [InlineData(0, 0, 0, true, 1, 1, 0)]    // New → Recognition (1 correct advances)
    [InlineData(1, 0, 1, true, 1, 1, 1)]    // Recognition needs 2 → stays, consec++
    [InlineData(1, 1, 1, true, 2, 3, 0)]    // 2nd correct → Recall
    [InlineData(2, 1, 3, true, 3, 7, 0)]    // → Context
    [InlineData(3, 1, 7, true, 4, 14, 0)]   // → Mastered
    [InlineData(2, 0, 3, true, 2, 3, 1)]    // first correct in stage → consec++, stays
    // Mastered → interval growth (×2, capped 60)
    [InlineData(4, 0, 14, true, 4, 28, 1)]  // doubles
    [InlineData(4, 0, 50, true, 4, 60, 1)]  // caps at 60
    [InlineData(4, 0, 60, true, 4, 60, 1)]  // already at cap → stays
    // Incorrect → demotion
    [InlineData(0, 0, 0, false, 0, 0.5, 0)] // stays at 0, retry interval
    [InlineData(1, 1, 1, false, 1, 0.5, 0)] // stays at 1
    [InlineData(2, 1, 3, false, 1, 1, 0)]   // → Recognition
    [InlineData(3, 0, 7, false, 2, 1, 0)]   // → Recall
    [InlineData(4, 3, 28, false, 2, 1, 0)]  // Mastered drops to Recall, not Context
    public void Calculate_ReturnsExpectedStageIntervalConsecutive(
        int stage, int consecutive, double interval, bool isCorrect,
        int expectedStage, double expectedInterval, int expectedConsecutive)
    {
        var (newStage, newInterval, newConsecutive) = _srs.Calculate(stage, consecutive, interval, isCorrect);

        Assert.Equal(expectedStage, newStage);
        Assert.Equal(expectedInterval, newInterval);
        Assert.Equal(expectedConsecutive, newConsecutive);
    }

    // F4 anti-spiral: retire only Mastered (stage 4) with ≥3 consecutive correct
    // AND interval ≥ 14 days.
    [Theory]
    [InlineData(4, 3, 14, true)]    // boundary: interval == 14 retires
    [InlineData(4, 5, 60, true)]
    [InlineData(3, 10, 60, false)]  // not Mastered
    [InlineData(4, 2, 60, false)]   // only 2 consecutive
    [InlineData(4, 5, 13, false)]   // interval below 14
    public void ShouldAutoRetire_ReturnsExpected(int stage, int consecutiveCorrect, double intervalDays, bool expected)
    {
        Assert.Equal(expected, _srs.ShouldAutoRetire(stage, consecutiveCorrect, intervalDays));
    }
}
