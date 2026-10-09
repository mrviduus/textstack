using System.Text.RegularExpressions;
using Application.Ai;
using TextStack.Ai.Core;

namespace TextStack.Ai.EvalSuite;

/// <summary>An ambiguous English word inside a book sentence, plus the sense it carries there.</summary>
public record TranslateSenseGolden(string Word, string Sentence, string Sense);

public record TranslateSenseCase(string Word, string TargetLang, string? Translation, bool Correct, string? Error);

public record TranslateSenseResult(int N, double Accuracy, IReadOnlyList<TranslateSenseCase> Cases);

/// <summary>
/// Word-sense eval for <c>POST /translate</c> (QA-007: "pocketed" → "enterrado"). Each case is
/// translated with the REAL production prompt (<see cref="TranslatePrompt"/>), with or without the
/// sentence, then a judge answers one binary question: does the translation carry the sense the word
/// has in that sentence? Binary on purpose — a 3-axis rubric would let a fluent wrong sense score well.
/// Errors are data: a failed call or an unparseable verdict is a wrong case, never a thrown run.
/// </summary>
public static class TranslateSenseEvalRunner
{
    private const string JudgeSystem =
        "You grade word translations. Given an English word, the sentence it appears in, the sense it has " +
        "there, and a translation of the word alone, decide whether the translation expresses THAT sense " +
        "(any inflection, synonym or short clarifier is fine). Reply with CORRECT or WRONG on the first " +
        "line, then one short reason.";

    private static readonly Regex NegativeVerdict = new(@"\b(INCORRECT|WRONG|NOT\s+CORRECT)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex CorrectVerdict = new(@"\bCORRECT\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>EVAL-1: the verdict is the first NON-EMPTY line only (the reason below it may name either word).
    /// On that line a negative (INCORRECT, WRONG, NOT CORRECT) wins, so "Not correct" is not read as
    /// CORRECT; otherwise CORRECT, decorated or not ("**CORRECT**"). No verdict word is wrong.</summary>
    public static bool IsCorrectVerdict(string text)
    {
        var first = text.TrimStart().Split('\n')[0];
        return !NegativeVerdict.IsMatch(first) && CorrectVerdict.IsMatch(first);
    }

    public static IReadOnlyList<TranslateSenseGolden> LoadGoldens() =>
        GoldenLoader.Load<TranslateSenseGolden>("translate_senses.json");

    public static async Task<TranslateSenseResult> RunAsync(
        ILlmService generator,
        ILlmService judge,
        IReadOnlyList<TranslateSenseGolden> goldens,
        IReadOnlyList<string> targetLangs,
        bool withContext,
        CancellationToken ct)
    {
        var work = goldens.SelectMany(g => targetLangs.Select(t => (g, t))).ToList();
        var cases = new TranslateSenseCase[work.Count];

        await Parallel.ForEachAsync(Enumerable.Range(0, work.Count),
            new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct },
            async (i, token) =>
            {
                var (g, target) = work[i];
                cases[i] = await RunCaseAsync(generator, judge, g, target, withContext, token);
            });

        var correct = cases.Count(c => c.Correct);
        return new TranslateSenseResult(cases.Length, cases.Length == 0 ? 0 : (double)correct / cases.Length, cases);
    }

    private static async Task<TranslateSenseCase> RunCaseAsync(
        ILlmService generator, ILlmService judge, TranslateSenseGolden g, string target, bool withContext, CancellationToken ct)
    {
        string translation;
        try
        {
            var gen = await generator.CompleteAsync(new LlmRequest(
                TranslatePrompt.BuildSystemPrompt("en", target, genre: null, withContext ? g.Sentence : null),
                [new LlmMessage("user", g.Word)],
                MaxOutputTokens: 100, FeatureTag: "translate"), ct);
            translation = gen.Text.Trim();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new TranslateSenseCase(g.Word, target, null, false, "generate: " + ex.Message);
        }

        try
        {
            var verdict = await judge.CompleteAsync(new LlmRequest(
                JudgeSystem,
                [new LlmMessage("user",
                    $"Word: {g.Word}\nSentence: {g.Sentence}\nSense in this sentence: {g.Sense}\n" +
                    $"Target language: {target}\nTranslation: {translation}")],
                MaxOutputTokens: 60, FeatureTag: "eval-judge"), ct);
            var correct = IsCorrectVerdict(verdict.Text);
            return new TranslateSenseCase(g.Word, target, translation, correct, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new TranslateSenseCase(g.Word, target, translation, false, "judge: " + ex.Message);
        }
    }
}
