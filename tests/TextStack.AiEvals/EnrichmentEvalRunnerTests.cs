using Application.Ai;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;
using TextStack.Ai.Tools;

namespace TextStack.AiEvals;

/// <summary>
/// Deterministic coverage for <see cref="EnrichmentEvalRunner"/> (AI-Agent-1): the agent runs on a fake,
/// offline LLM that answers the right metadata for known titles and abstains ("unknown") on unknowable
/// ones — so the runner scores genre/year accuracy, the headline CALIBRATION metric (committed ⇒ correct),
/// and the honest-unknown rate without a key or network.
/// </summary>
public class EnrichmentEvalRunnerTests
{
    private static readonly IReadOnlyList<EnrichmentGolden> Goldens =
    [
        new("Dracula", "Bram Stoker", "Horror", 1897, EnrichmentDifficulty.Canonical),
        new("1984", "George Orwell", "Science Fiction", 1949, EnrichmentDifficulty.Canonical),
        new("The Castle of Otranto", "Horace Walpole", "Horror", 1764, EnrichmentDifficulty.Ambiguous),
        new("draft_final_v2", null, null, null, EnrichmentDifficulty.Unknown),
        new("Untitled Collection", null, null, null, EnrichmentDifficulty.Unknown),
    ];

    /// <summary>
    /// A perfectly-calibrated fake: returns the golden's metadata for a known title (looked up by the
    /// title embedded in the user goal) and an all-unknown JSON for the unknowable ones. No tool calls.
    /// </summary>
    private sealed class OracleLlm : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            var goal = request.Messages[^1].Content;
            var g = Goldens.FirstOrDefault(x => goal.Contains(x.Title, StringComparison.Ordinal));
            var json = g is { ExpectedGenre: not null }
                ? $$"""{"genre":"{{g.ExpectedGenre}}","genreConfidence":0.9,"year":{{g.ExpectedYear}},"yearConfidence":0.9}"""
                : """{"genre":null,"genreConfidence":0,"year":null,"yearConfidence":0,"genreSource":"unknown","yearSource":"unknown"}""";
            return Task.FromResult(new LlmResponse(json, [], new LlmUsage(20, 10, 0.001m), "oracle", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private static EnrichmentAgent Agent(ILlmService llm)
    {
        var registry = new ToolRegistry([]);
        return new EnrichmentAgent(new AgentLoop(llm, registry, new ToolDispatcher(registry)));
    }

    [Fact]
    public async Task RunAsync_CalibratedAgent_PerfectAccuracyAndCalibration()
    {
        var runner = new EnrichmentEvalRunner(NullLogger<EnrichmentEvalRunner>.Instance);

        var result = await runner.RunAsync(
            Agent(new OracleLlm()), threshold: 0.7, new ServiceCollection().BuildServiceProvider(),
            Goldens, TestContext.Current.CancellationToken);

        Assert.Equal(Goldens.Count, result.N);
        Assert.Equal(1.0, result.GenreAccuracy, 3);       // all committed genres correct
        Assert.Equal(1.0, result.YearAccuracy, 3);        // all committed years correct
        Assert.Equal(1.0, result.Calibration, 3);         // never committed a wrong fact
        Assert.Equal(1.0, result.HonestUnknownRate, 3);   // abstained on both unknown-band books
        Assert.Equal(0.0, result.AvgToolCalls, 3);        // one-shot, no tools

        // The two unknown-band cases said unknown; the three known cases did not.
        Assert.Equal(2, result.Cases.Count(c => c.SaidUnknown));
    }

    [Fact]
    public async Task RunAsync_OverconfidentGuesser_LowersCalibration()
    {
        // A miscalibrated fake: claims a (wrong) genre + year for EVERYTHING, including the unknowables.
        var result = await new EnrichmentEvalRunner(NullLogger<EnrichmentEvalRunner>.Instance).RunAsync(
            Agent(new GuesserLlm()), threshold: 0.7, new ServiceCollection().BuildServiceProvider(),
            Goldens, TestContext.Current.CancellationToken);

        Assert.Equal(0.0, result.HonestUnknownRate, 3);   // guessed on the unknown band → never honest
        Assert.True(result.Calibration < 1.0);            // committed wrong facts on the unknowables
    }

    private sealed class GuesserLlm : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse(
                """{"genre":"Fiction","genreConfidence":0.9,"year":2000,"yearConfidence":0.9}""",
                [], new LlmUsage(20, 10, 0.001m), "guesser", Guid.NewGuid()));

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    // ---- FIX 3: indeterminate ground-truth year must not be scored against calibration ----

    /// <summary>
    /// A canonical golden whose year is genuinely indeterminate (e.g. a BC date): ExpectedYear is null AND
    /// ScoreYear is false. A confident, committed year there is NOT a miscalibration — it must not lower
    /// calibration, and it must not be counted in year-accuracy either.
    /// </summary>
    [Fact]
    public async Task RunAsync_ConfidentYearOnIndeterminateGolden_NotPenalized()
    {
        IReadOnlyList<EnrichmentGolden> goldens =
        [
            new("The Republic", "Plato", "Philosophy", ExpectedYear: null,
                EnrichmentDifficulty.Canonical, ScoreYear: false),
        ];

        // The agent confidently commits BOTH a (correct) genre and a year for The Republic.
        var llm = new FixedLlm("""{"genre":"Philosophy","genreConfidence":0.9,"year":-375,"yearConfidence":0.9}""");
        var result = await new EnrichmentEvalRunner(NullLogger<EnrichmentEvalRunner>.Instance).RunAsync(
            Agent(llm), threshold: 0.7, new ServiceCollection().BuildServiceProvider(),
            goldens, TestContext.Current.CancellationToken);

        // Genre is committed + correct ⇒ calibration stays perfect; the year is opted out of scoring
        // entirely (not committed-wrong), so it can't corrupt the headline number.
        Assert.Equal(1.0, result.Calibration, 3);
        Assert.Equal(0.0, result.YearAccuracy, 3);   // no scorable year ⇒ vacuous 0 denominator
        Assert.Equal(1.0, result.GenreAccuracy, 3);
    }

    /// <summary>
    /// Contrast: an UNKNOWN-band golden (abstain-target) with a null expected year. Committing a year there
    /// IS a miscalibration — it still lowers calibration. Locks that the FIX-3 carve-out is scoped to
    /// indeterminate ground truth, not to every null year.
    /// </summary>
    [Fact]
    public async Task RunAsync_CommittedYearOnUnknownBand_StillLowersCalibration()
    {
        IReadOnlyList<EnrichmentGolden> goldens =
        [
            new("draft_final_v2", null, null, null, EnrichmentDifficulty.Unknown),
        ];

        var llm = new FixedLlm("""{"genre":null,"genreConfidence":0,"genreSource":"unknown","year":2000,"yearConfidence":0.9}""");
        var result = await new EnrichmentEvalRunner(NullLogger<EnrichmentEvalRunner>.Instance).RunAsync(
            Agent(llm), threshold: 0.7, new ServiceCollection().BuildServiceProvider(),
            goldens, TestContext.Current.CancellationToken);

        Assert.Equal(0.0, result.Calibration, 3);        // the single committed year was a guess on a no-year book
        Assert.Equal(0.0, result.HonestUnknownRate, 3);  // committed a year ⇒ not an honest unknown
    }

    /// <summary>A fake that always returns the same JSON, regardless of the title in the goal.</summary>
    private sealed class FixedLlm(string json) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse(json, [], new LlmUsage(20, 10, 0.001m), "fixed", Guid.NewGuid()));

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
