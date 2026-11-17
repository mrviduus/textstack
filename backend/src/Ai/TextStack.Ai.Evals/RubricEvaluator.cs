using Microsoft.Extensions.AI;
using Microsoft.Extensions.AI.Evaluation;

namespace TextStack.Ai.Evals;

/// <summary>
/// Carries the per-case judge <b>evidence</b> string (inputs + reference + actual,
/// built exactly as the legacy <see cref="JudgeRunner"/> received it) into a
/// <see cref="RubricEvaluator"/> via MEAI's <c>additionalContext</c>. Passing the
/// identical evidence is what keeps new scores comparable with the old runner.
/// </summary>
public sealed class RubricEvidenceContext(string evidence)
    : EvaluationContext("RubricEvidence", evidence)
{
    public string Evidence { get; } = evidence;
}

/// <summary>
/// MEAI <see cref="IEvaluator"/> port of <see cref="JudgeRunner"/>: runs the SAME
/// judge system prompt (<see cref="JudgeRunner.BuildSystemPrompt"/>) over the SAME
/// evidence via the injected judge <see cref="IChatClient"/>, parses the SAME strict
/// JSON (<see cref="JudgeRunner.ParseScore"/>), and emits the three rubric axes plus
/// an overall as <see cref="NumericMetric"/>s (1–5). Given the same judge response the
/// numbers are identical to the legacy path — that is the parity guarantee.
///
/// <para>Metric names are prefixed with <paramref name="id"/> (the facet key, e.g.
/// <c>vocab.hint</c>) so multiple facet evaluators in one scenario don't collide on
/// "overall". When <paramref name="overallFloor"/> is set, the overall metric is
/// interpreted Pass/Fail against that floor — the same threshold the old test asserted.</para>
/// </summary>
public sealed class RubricEvaluator(string id, Rubric rubric, double? overallFloor = null) : IEvaluator
{
    private string D1 => $"{id}.{Label(rubric.Dim1)}";
    private string D2 => $"{id}.{Label(rubric.Dim2)}";
    private string D3 => $"{id}.{Label(rubric.Dim3)}";
    private string Overall => $"{id}.overall";

    public IReadOnlyCollection<string> EvaluationMetricNames => [D1, D2, D3, Overall];

    public async ValueTask<EvaluationResult> EvaluateAsync(
        IEnumerable<ChatMessage> messages,
        ChatResponse modelResponse,
        ChatConfiguration? chatConfiguration = null,
        IEnumerable<EvaluationContext>? additionalContext = null,
        CancellationToken cancellationToken = default)
    {
        var judge = chatConfiguration?.ChatClient
            ?? throw new InvalidOperationException($"{nameof(RubricEvaluator)} requires a ChatConfiguration with a judge ChatClient.");

        var evidence = additionalContext?.OfType<RubricEvidenceContext>().FirstOrDefault()?.Evidence
            ?? throw new InvalidOperationException($"{nameof(RubricEvaluator)} requires a {nameof(RubricEvidenceContext)} in additionalContext.");

        // Same judge call shape as JudgeRunner: system prompt from the rubric,
        // evidence as the user turn, 300-token budget, eval.judge feature tag.
        var judgeMessages = new[]
        {
            new ChatMessage(ChatRole.System, JudgeRunner.BuildSystemPrompt(rubric)),
            new ChatMessage(ChatRole.User, evidence),
        };
        var options = new ChatOptions
        {
            MaxOutputTokens = 300,
            AdditionalProperties = new() { ["FeatureTag"] = "eval.judge" },
        };

        var response = await judge.GetResponseAsync(judgeMessages, options, cancellationToken);
        var score = JudgeRunner.ParseScore(response.Text);

        var d1 = new NumericMetric(D1, score.D1, reason: score.Rationale);
        var d2 = new NumericMetric(D2, score.D2);
        var d3 = new NumericMetric(D3, score.D3);
        var overall = new NumericMetric(Overall, score.Mean);

        if (score.D1 == 0 && score.D2 == 0 && score.D3 == 0)
            overall.AddDiagnostics(EvaluationDiagnostic.Warning($"Judge verdict unparseable: {score.Rationale}"));

        if (overallFloor is { } floor)
            overall.Interpretation = new EvaluationMetricInterpretation(
                RatingFor(score.Mean),
                failed: score.Mean < floor,
                reason: $"floor {floor:0.0} (mean {score.Mean:0.00})");

        return new EvaluationResult(d1, d2, d3, overall);
    }

    // Bucket a 0–5 mean into MEAI's qualitative rating (report colour only; the
    // numeric gate is `failed` vs the floor).
    private static EvaluationRating RatingFor(double mean) => mean switch
    {
        >= 4.5 => EvaluationRating.Exceptional,
        >= 4.0 => EvaluationRating.Good,
        >= 3.0 => EvaluationRating.Average,
        >= 2.0 => EvaluationRating.Poor,
        > 0.0 => EvaluationRating.Unacceptable,
        _ => EvaluationRating.Inconclusive,
    };

    // Same label rule as EvalSuiteRunner.Label: text before the first ':'.
    private static string Label(string dim) => dim.Split(':')[0].Trim();
}
