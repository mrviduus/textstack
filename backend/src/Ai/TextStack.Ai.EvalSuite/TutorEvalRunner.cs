using System.Text.Json;
using Application.Agents;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace TextStack.Ai.EvalSuite;

/// <summary>One Tutor golden's outcome — surfaced per case for the admin UI / test assertions.</summary>
public sealed record TutorCase(
    string Name,
    int Planned,
    double DueCoverage,
    double WeakTargeting,
    bool DifficultyAppropriate,
    bool NoHallucination,
    bool ThesisAligned,
    int ToolCalls);

/// <summary>
/// Result of a Tutor-agent eval run (AI-Agent-2). Evaluating a tutor offline is genuinely hard — there is no
/// single ground-truth plan — so the rubric is STRUCTURAL and deterministic (no LLM judge):
/// <list type="bullet">
/// <item><b>DueCoverage</b> — fraction of the genuinely-due cards the plan included.</item>
/// <item><b>WeakTargeting</b> — fraction of the prioritized (early items in the) plan that are weak cards.</item>
/// <item><b>DifficultyAppropriateness</b> — every item's exercise type matches its card's SRS stage (no jump).</item>
/// <item><b>NoHallucination</b> — every planned <c>wordId</c> exists in the input state (the hard guarantee).</item>
/// <item><b>ThesisAlignment</b> — the plan is bounded (≤ <see cref="TutorAgent.MaxPlanItems"/>) and not an
///   endless drill, and it carries a reading nudge.</item>
/// </list>
/// Honest caveat (per the design doc): this validates the planner's MECHANICS + policy, not real pedagogical
/// efficacy — that needs a longitudinal retention A/B, out of scope for the portfolio.
/// </summary>
public sealed record TutorEvalResult(
    double DueCoverage,
    double WeakTargeting,
    double DifficultyAppropriateness,
    double NoHallucinationRate,
    double ThesisAlignment,
    double AvgToolCalls,
    int N,
    IReadOnlyList<TutorCase> Cases);

/// <summary>
/// Runs the Tutor eval over synthetic learner states: for each golden it wires the REAL <see cref="TutorAgent"/>
/// to FAKE tools that serve that golden's cards + reading context (so the run is fully offline + deterministic
/// given the supplied <paramref name="llm"/>), runs the agent, and scores the structural rubric. The supplied
/// <see cref="ILlmService"/> is the only non-deterministic seam — tests pass a scripted/oracle fake; the admin
/// path routes it through the gateway (FeatureTag <c>tutor.agent</c>).
/// </summary>
public sealed class TutorEvalRunner(ILogger<TutorEvalRunner> logger)
{
    public async Task<TutorEvalResult> RunAsync(ILlmService llm, CancellationToken ct)
    {
        var goldens = GoldenLoader.Load<TutorGolden>("tutor.json");
        return await RunAsync(llm, goldens, ct);
    }

    /// <summary>Overload taking an explicit golden set (used by tests to keep the run small + deterministic).</summary>
    public async Task<TutorEvalResult> RunAsync(
        ILlmService llm, IReadOnlyList<TutorGolden> goldens, CancellationToken ct)
    {
        var cases = new List<TutorCase>();
        double dueSum = 0, weakSum = 0;
        int dueScored = 0, weakScored = 0;
        int diffAppropriate = 0, noHallucination = 0, thesisAligned = 0;
        var totalToolCalls = 0;

        foreach (var g in goldens)
        {
            ct.ThrowIfCancellationRequested();

            var agent = BuildAgent(llm, g);
            var ctx = new AgentContext(Guid.NewGuid(), null, Guid.NewGuid(), EmptyServices);

            TutorPlan plan;
            int toolCalls;
            try
            {
                var outcome = await agent.RunAsync(new TutorInput(g.ExpectedDueWordIds.Count > 0 ? 7 : 5), ctx, ct);
                plan = outcome.Plan;
                toolCalls = outcome.ToolCallsCount;
            }
            catch (AgentBudgetExhaustedException)
            {
                plan = TutorPlan.Empty("budget exhausted");
                toolCalls = 0;
            }

            var cardsById = g.Cards.ToDictionary(c => c.WordId, StringComparer.Ordinal);

            // (a) Due coverage: of the genuinely-due cards, how many did the plan include?
            double dueCoverage = 1.0;
            if (g.ExpectedDueWordIds.Count > 0)
            {
                var plannedIds = plan.Items.Select(i => i.WordId.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var hit = g.ExpectedDueWordIds.Count(id => plannedIds.Contains(id));
                dueCoverage = (double)hit / g.ExpectedDueWordIds.Count;
                dueSum += dueCoverage;
                dueScored++;
            }

            // (b) Weak targeting: of the FIRST half of the plan (the prioritized slot), how many are weak cards?
            double weakTargeting = 1.0;
            if (g.ExpectedWeakWordIds.Count > 0 && plan.Items.Count > 0)
            {
                var weak = g.ExpectedWeakWordIds.ToHashSet(StringComparer.Ordinal);
                var head = plan.Items.Take(Math.Max(1, plan.Items.Count / 2)).ToList();
                var weakInHead = head.Count(i => weak.Contains(i.WordId.ToString()));
                weakTargeting = (double)weakInHead / head.Count;
                weakSum += weakTargeting;
                weakScored++;
            }

            // (c) Difficulty appropriateness: every item's exercise type is the one CalibrateForStage would pick
            // for its real card stage — no jarring jump (the agent re-projects this, so this should hold).
            var difficultyOk = plan.Items.All(i =>
                cardsById.TryGetValue(i.WordId.ToString(), out var card)
                && ExpectedExercise(card) == i.ExerciseType);

            // (d) No hallucination: every planned wordId exists in the input state — the hard guarantee.
            var hallucinationFree = plan.Items.All(i => cardsById.ContainsKey(i.WordId.ToString()));

            // (e) Thesis alignment: bounded plan (not a marathon) + a closing reading nudge.
            var thesisOk = plan.Items.Count <= TutorAgent.MaxPlanItems
                && !string.IsNullOrWhiteSpace(plan.ReadingNudge);

            if (difficultyOk) diffAppropriate++;
            if (hallucinationFree) noHallucination++;
            if (thesisOk) thesisAligned++;
            totalToolCalls += toolCalls;

            cases.Add(new TutorCase(
                g.Name, plan.Items.Count, dueCoverage, weakTargeting,
                difficultyOk, hallucinationFree, thesisOk, toolCalls));
        }

        var n = cases.Count;
        var res = new TutorEvalResult(
            DueCoverage: dueScored > 0 ? dueSum / dueScored : 1.0,
            WeakTargeting: weakScored > 0 ? weakSum / weakScored : 1.0,
            DifficultyAppropriateness: n > 0 ? (double)diffAppropriate / n : 1.0,
            NoHallucinationRate: n > 0 ? (double)noHallucination / n : 1.0,
            ThesisAlignment: n > 0 ? (double)thesisAligned / n : 1.0,
            AvgToolCalls: n > 0 ? (double)totalToolCalls / n : 0,
            N: n,
            Cases: cases);

        logger.LogInformation(
            "Tutor eval dueCov={Due:0.00} weakTgt={Weak:0.00} diffApt={Diff:0.00} noHalluc={Hal:0.00} thesis={Thesis:0.00} avgTools={Tools:0.0} (N={N})",
            res.DueCoverage, res.WeakTargeting, res.DifficultyAppropriateness, res.NoHallucinationRate, res.ThesisAlignment, res.AvgToolCalls, n);

        return res;
    }

    /// <summary>The exercise type the deterministic calibration rule would pick for a synthetic card's stage.</summary>
    private static string ExpectedExercise(TutorCard card) =>
        TutorAgent.CalibrateForStage(new RetrievedCard(
            Guid.Parse(card.WordId), card.Word, card.Stage, card.ConsecutiveCorrect, card.Accuracy, card.HasSentence))
            .ExerciseType;

    private static readonly IServiceProvider EmptyServices = new ServiceCollection().BuildServiceProvider();

    /// <summary>Wires the real agent to fake tools serving this golden's synthetic state.</summary>
    private static TutorAgent BuildAgent(ILlmService llm, TutorGolden g)
    {
        var due = g.Cards.Where(c => c.Due).ToList();
        var weak = g.Cards
            .Where(c => g.ExpectedWeakWordIds.Contains(c.WordId, StringComparer.Ordinal))
            .ToList();

        ITool[] tools =
        [
            new FixedCardTool("get_due_vocabulary", due),
            new FixedCardTool("get_weak_vocabulary", weak),
            new FixedJsonTool("get_reading_context", ReadingJson(g)),
        ];

        var registry = new ToolRegistry(tools);
        return new TutorAgent(new AgentLoop(llm, registry, new ToolDispatcher(registry)));
    }

    private static string ReadingJson(TutorGolden g) =>
        g.ReadingBook is null
            ? """{"count":0,"books":[]}"""
            : JsonSerializer.Serialize(new
            {
                count = 1,
                books = new[] { new { title = g.ReadingBook, language = g.ReadingLanguage, source = "library" } },
            });

    /// <summary>A fake card tool returning a fixed list of synthetic cards in the same shape the real tools emit.</summary>
    private sealed class FixedCardTool(string name, IReadOnlyList<TutorCard> cards) : ITool
    {
        public string Name => name;
        public string Description => "eval fake";
        public JsonElement ArgsSchema => AnyObjectSchema;
        public Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct)
        {
            var words = cards.Select(c => new
            {
                wordId = c.WordId,
                word = c.Word,
                stage = c.Stage,
                consecutiveCorrect = c.ConsecutiveCorrect,
                lastAccuracy = c.Accuracy,
                hasSentence = c.HasSentence,
            });
            return Task.FromResult(JsonSerializer.SerializeToElement(new { count = cards.Count, words }));
        }
    }

    private sealed class FixedJsonTool(string name, string json) : ITool
    {
        public string Name => name;
        public string Description => "eval fake";
        public JsonElement ArgsSchema => AnyObjectSchema;
        public Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct) =>
            Task.FromResult(JsonDocument.Parse(json).RootElement.Clone());
    }

    private static readonly JsonElement AnyObjectSchema =
        JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone();
}
