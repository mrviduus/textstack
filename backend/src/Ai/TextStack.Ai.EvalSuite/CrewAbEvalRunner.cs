using System.Globalization;
using System.Text;
using Application.Agents;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Utilities;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.AI.Evaluation;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Ai.Evals;
using TextStack.Ai.Llm;

namespace TextStack.Ai.EvalSuite;

/// <summary>
/// One fixture's A/B outcome (AI-046). <see cref="JudgeScoreA"/>/<see cref="JudgeScoreB"/> are the independent
/// judge's 0-5 means for the single-call baseline (A) and the full crew (B); a crew that halted before the
/// editor (null EditedText) scores B = 0. <see cref="CostA"/>/<see cref="CostB"/> are the honest USD costs
/// (A = the single call's usage; B = the crew run's total across its four sub-agents). <see cref="BWins"/> is
/// true when B's judge mean strictly beats A's.
/// </summary>
public sealed record CrewAbCase(
    string Id, double JudgeScoreA, double JudgeScoreB, decimal CostA, decimal CostB, bool BWins);

/// <summary>
/// Result of a crew-vs-single-call A/B run (AI-046, Phase 7 DoD gate). <see cref="LiftPct"/> is the headline
/// metric: the crew's mean judge score over the baseline's, as a fraction. <see cref="CostRatio"/> is the
/// crew's total spend over the baseline's. The gate demands BOTH a meaningful quality lift AND a bounded cost
/// multiple — a crew that is better but ruinously expensive does not earn its orchestration.
/// </summary>
public sealed record CrewAbEvalResult(
    double AvgA,
    double AvgB,
    double LiftPct,
    double CostRatio,
    double WinRate,
    int N,
    bool Passed,
    IReadOnlyList<CrewAbCase> Cases);

/// <summary>
/// Runs the Phase 7 crew-vs-single-call A/B eval (AI-046): for each golden, send the SAME brief + source
/// through (A) the single-call <see cref="BaselineFieldAgent"/> that writes the field directly and (B) the full
/// <see cref="FieldCrew"/> (researcher → drafter → critic → editor). Both arms use the SAME generator model
/// (nano) so only ORCHESTRATION differs, not the rubric. An independent, STRONGER judge (gpt-4.1 via
/// <c>Eval:JudgeModel</c>) scores each candidate absolutely on a 3-axis 1-5 rubric (grounding / tone /
/// completeness) — A and B in SEPARATE calls with the SAME rubric, and the judge NEVER learns which arm a
/// candidate came from (no "single-call" vs "crew" label leakage). Reports crew lift % and cost ratio and
/// gates on liftPct ≥ 0.10 AND costRatio ≤ 2.0. Persists a <c>crew_ab</c> <see cref="EvalRun"/> (Score = lift).
/// Mirrors <see cref="CriticDefectEvalRunner"/>: real generation per case, judged scoring, sync.
/// </summary>
public sealed class CrewAbEvalRunner(ILogger<CrewAbEvalRunner> logger)
{
    private const string Feature = "crew_ab";

    /// <summary>Minimum crew quality lift over the single-call baseline (fraction) the orchestration must earn.</summary>
    public const double LiftGate = 0.10;

    /// <summary>Maximum crew cost as a multiple of the single-call baseline's — keeps the lift honest about spend.</summary>
    public const double CostRatioGate = 2.0;

    // Absolute prose rubric. Axis labels (text before ':') become the RubricEvaluator metric suffixes the
    // judge scores 1-5; the judge sees only an anonymous candidate + the source — never the arm it came from.
    private static readonly Rubric Rubric = new(
        "grounding: every claim is supported by the source material; no invented facts.",
        "tone: factual, encyclopedic, third-person prose with no subjective superlatives or marketing language.",
        "completeness: covers the field within its length bounds, reads clearly, and reads well as a whole.");

    private static readonly ChatMessage[] JudgePlaceholderMessages = [new ChatMessage(ChatRole.User, string.Empty)];

    public async Task<CrewAbEvalResult> RunAsync(
        BaselineFieldAgent baseline,
        FieldCrew crew,
        ILlmService judge,
        string judgeModelId,
        bool persist,
        IAppDbContext? db,
        string? gitSha,
        CancellationToken ct)
    {
        var goldens = CrewAbGoldenSet.Load();
        var chatConfig = new ChatConfiguration(new LlmServiceChatClient(judge, defaultFeatureTag: "eval.judge"));

        // The crew's CrewTasks.Of opens a child DI scope per stage (ToolDispatcher per-invocation rule), so its
        // AgentContext.Services must expose IServiceScopeFactory. An empty container provides exactly that and
        // resolves no tools — the crew specialists are single ILlmService calls. The baseline ignores Services.
        using var crewServices = new ServiceCollection().BuildServiceProvider();

        var cases = new List<CrewAbCase>();
        var sumA = 0.0;
        var sumB = 0.0;
        var sumCostA = 0m;
        var sumCostB = 0m;
        var bWins = 0;

        foreach (var g in goldens)
        {
            ct.ThrowIfCancellationRequested();

            var brief = SeoBriefs.For(g.EntityType, g.FieldName, g.TargetLanguage);

            // A — single LLM call. SingleCallAgent ignores ctx.Services (no tools); an empty provider suffices.
            var ctxA = new AgentContext(UserId: null, EditionId: null, Guid.NewGuid(), EmptyServiceProvider.Instance);
            var aResult = await baseline.RunAsync(new BaselineInput(brief, g.SourceMaterial), ctxA, ct);
            var textA = aResult.Output.Text;
            var costA = aResult.Usage.CostUsdTotal;

            // B — the full crew. Cost is the run total (sum of the 4 sub-agent usages), surfaced on FieldResult.
            var ctxB = new AgentContext(UserId: null, EditionId: null, Guid.NewGuid(), crewServices);
            var bResult = await crew.RunFieldAsync(
                "crew_ab", "edition.description", AutoPublishCrew.CostCapUsd, brief, g.SourceMaterial, ctxB, ct);
            var textB = bResult.EditedText; // null when the crew halted before the editor
            var costB = bResult.CostUsd;

            // Judge each candidate against the SAME source with the SAME rubric, in SEPARATE calls. The crew's
            // null edited text (halted pre-edit) scores 0 — there is no prose to judge.
            var scoreA = await JudgeAsync(brief, g.SourceMaterial, textA, chatConfig, ct);
            var scoreB = textB is null ? 0.0 : await JudgeAsync(brief, g.SourceMaterial, textB, chatConfig, ct);

            var won = scoreB > scoreA;
            cases.Add(new CrewAbCase(g.Id, scoreA, scoreB, costA, costB, won));
            sumA += scoreA;
            sumB += scoreB;
            sumCostA += costA;
            sumCostB += costB;
            if (won)
                bWins++;
        }

        var n = cases.Count;
        var avgA = n > 0 ? sumA / n : 0.0;
        var avgB = n > 0 ? sumB / n : 0.0;
        var liftPct = avgA > 0 ? (avgB - avgA) / avgA : 0.0; // avgA == 0 → no lift basis → 0 (fails gate)
        var costRatio = sumCostA > 0 ? (double)(sumCostB / sumCostA) : double.PositiveInfinity; // no A spend → +inf
        var winRate = n > 0 ? (double)bWins / n : 0.0;
        var passed = liftPct >= LiftGate && costRatio <= CostRatioGate;

        logger.LogInformation(
            "Crew A/B eval: avgA={AvgA:0.00} avgB={AvgB:0.00} lift={Lift:0.000} costRatio={Ratio:0.00} winRate={Win:0.00} (N={N}) passed={Passed}",
            avgA, avgB, liftPct, costRatio, winRate, n, passed);

        if (persist && db is not null)
        {
            db.EvalRuns.Add(new EvalRun
            {
                Id = Guid.NewGuid(),
                Feature = Feature,
                ModelId = "crew.baseline-vs-crew", // both arms share the nano generator; the headline is the comparison
                JudgeModelId = judgeModelId,
                Score = Math.Round((decimal)liftPct, 3),
                N = n,
                BreakdownJson = BuildBreakdown(avgA, avgB, liftPct, costRatio, winRate, n, cases),
                GitSha = gitSha,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync(ct);
        }

        return new CrewAbEvalResult(avgA, avgB, liftPct, costRatio, winRate, n, passed, cases);
    }

    /// <summary>
    /// Score one anonymous candidate against the source on the shared prose rubric (mean of the 3 axes, 0-5).
    /// The judge prompt carries only the source + the candidate — never "single-call" or "crew" — so there is
    /// no label leakage that could bias the A/B comparison.
    /// </summary>
    private static async Task<double> JudgeAsync(
        ContentBrief brief, string source, string candidate, ChatConfiguration chatConfig, CancellationToken ct)
    {
        var evidence =
            $"Field: the {brief.FieldName} of a {brief.EntityType} ({brief.MinLength}-{brief.MaxLength} characters, " +
            $"in {LanguageNames.ToEnglishName(brief.TargetLanguage)}).\n\nSource material:\n{source}\n\nCandidate text:\n{candidate}";

        var evaluator = new RubricEvaluator(Feature, Rubric);
        var result = await evaluator.EvaluateAsync(
            JudgePlaceholderMessages,
            new ChatResponse(new ChatMessage(ChatRole.Assistant, candidate)),
            chatConfig,
            [new RubricEvidenceContext(evidence)],
            ct);

        var score = new JudgeScore(
            ReadAxis(result, Rubric.Dim1), ReadAxis(result, Rubric.Dim2), ReadAxis(result, Rubric.Dim3), string.Empty);
        return score.Mean;
    }

    private static int ReadAxis(EvaluationResult result, string dim) =>
        (int)Math.Round(result.Get<NumericMetric>($"{Feature}.{dim.Split(':')[0].Trim()}").Value ?? 0);

    private static string BuildBreakdown(
        double avgA, double avgB, double liftPct, double costRatio, double winRate, int n,
        IReadOnlyList<CrewAbCase> cases)
    {
        var sb = new StringBuilder();
        sb.Append('{');
        sb.Append("\"avgA\":").Append(Num(avgA)).Append(',');
        sb.Append("\"avgB\":").Append(Num(avgB)).Append(',');
        sb.Append("\"liftPct\":").Append(Num(liftPct)).Append(',');
        sb.Append("\"costRatio\":").Append(CostRatioJson(costRatio)).Append(',');
        sb.Append("\"winRate\":").Append(Num(winRate)).Append(',');
        sb.Append("\"n\":").Append(n).Append(',');

        sb.Append("\"perFixture\":[");
        for (var i = 0; i < cases.Count; i++)
        {
            var c = cases[i];
            if (i > 0)
                sb.Append(',');
            sb.Append("{\"id\":\"").Append(Escape(c.Id)).Append("\",")
              .Append("\"scoreA\":").Append(Num(c.JudgeScoreA)).Append(',')
              .Append("\"scoreB\":").Append(Num(c.JudgeScoreB)).Append(',')
              .Append("\"costA\":").Append(Cost(c.CostA)).Append(',')
              .Append("\"costB\":").Append(Cost(c.CostB)).Append(',')
              .Append("\"bWins\":").Append(c.BWins ? "true" : "false")
              .Append('}');
        }
        sb.Append(']');

        sb.Append('}');
        return sb.ToString();
    }

    // +inf serializes as JSON null (no valid IEEE literal) so the breakdown stays parseable when A had no spend.
    private static string CostRatioJson(double ratio) =>
        double.IsPositiveInfinity(ratio) ? "null" : Num(ratio);

    private static string Num(double value) =>
        Math.Round(value, 3).ToString("0.###", CultureInfo.InvariantCulture);

    private static string Cost(decimal value) =>
        Math.Round(value, 6).ToString("0.######", CultureInfo.InvariantCulture);

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>No-service provider for both arms' <see cref="AgentContext"/> — neither resolves tools.</summary>
    private sealed class EmptyServiceProvider : IServiceProvider
    {
        public static readonly EmptyServiceProvider Instance = new();
        public object? GetService(Type serviceType) => null;
    }
}
