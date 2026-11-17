namespace TextStack.Vocabulary;

public interface ISrsEngine
{
    (int NewStage, double NewInterval, int NewConsecutive) Calculate(
        int stage, int consecutiveCorrect, double currentInterval, bool isCorrect);

    bool ShouldAutoRetire(int stage, int consecutiveCorrect, double intervalDays);
}
