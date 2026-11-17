namespace TextStack.Vocabulary;

public sealed class SrsEngine : ISrsEngine
{
    // Stages: 0=New, 1=Recognition, 2=Recall, 3=Context, 4=Mastered
    private const int MaxStage = 4;
    private const double MaxMasteredIntervalDays = 60;
    private const double MasteredIntervalMultiplier = 2;
    private const double IncorrectRetryIntervalDays = 0.5;

    // Base review intervals per stage (days)
    private static readonly double[] BaseIntervals = [0, 1, 3, 7, 14];

    public (int NewStage, double NewInterval, int NewConsecutive) Calculate(
        int stage, int consecutiveCorrect, double currentInterval, bool isCorrect)
    {
        if (isCorrect)
        {
            var needed = stage == 0 ? 1 : 2;
            var newConsecutive = consecutiveCorrect + 1;

            if (newConsecutive >= needed && stage < MaxStage)
            {
                var newStage = stage + 1;
                return (newStage, BaseIntervals[newStage], 0);
            }

            if (stage == MaxStage)
            {
                var newInterval = Math.Min(currentInterval * MasteredIntervalMultiplier, MaxMasteredIntervalDays);
                return (MaxStage, newInterval, newConsecutive);
            }

            return (stage, stage == 0 ? 0 : BaseIntervals[stage], newConsecutive);
        }

        // Incorrect: demote by 1 (mastered drops to recall, not context)
        if (stage <= 1)
            return (stage, IncorrectRetryIntervalDays, 0);

        var demotedStage = stage == MaxStage ? 2 : stage - 1;
        return (demotedStage, 1, 0);
    }

    // Anti-spiral: Mastered words otherwise loop forever at 60-day cap.
    // 2000 mastered = ~33 reviews/day silently — the real queue-balloon driver.
    // Three consecutive correct at Stage 4 with interval ≥14d means the
    // user has demonstrated real retention — retire from active review.
    // Reader-tap unretires (falls back to Stage 3, one resurfacing review).
    public bool ShouldAutoRetire(int stage, int consecutiveCorrect, double intervalDays)
        => stage == MaxStage && consecutiveCorrect >= 3 && intervalDays >= 14;
}
