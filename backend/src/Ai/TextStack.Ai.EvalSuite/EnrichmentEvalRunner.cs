using Application.Agents;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;

namespace TextStack.Ai.EvalSuite;

/// <summary>One enrichment golden's outcome — surfaced per case for the admin UI / test assertions.</summary>
public sealed record EnrichmentCase(
    string Title,
    string Difficulty,
    string? GenreActual,
    int? YearActual,
    double Confidence,
    int ToolCalls,
    bool GenreCorrect,
    bool YearCorrect,
    bool SaidUnknown);

/// <summary>
/// Result of an Enrichment-agent eval run (AI-Agent-1). The headline number is <see cref="Calibration"/>:
/// of the items the agent committed with confidence (i.e. did NOT say unknown), what fraction were
/// actually correct — we WANT it to abstain on genuinely-unknown books rather than guess. Alongside it:
/// raw genre/year accuracy, the honest-unknown rate on the unknown band, and average tool calls (a
/// canonical classic should one-shot ⇒ low tool use).
/// </summary>
public sealed record EnrichmentEvalResult(
    double GenreAccuracy,
    double YearAccuracy,
    double Calibration,
    double HonestUnknownRate,
    double AvgToolCalls,
    int N,
    IReadOnlyList<EnrichmentCase> Cases);

/// <summary>
/// Runs the Phase-1 enrichment eval: for each golden, runs the REAL <see cref="EnrichmentAgent"/> (its
/// tools hit Open Library; with a fake/offline LLM in tests they return data and the agent still
/// produces a calibrated result), then scores accuracy + calibration deterministically (no LLM judge —
/// the ground truth is in the golden). Takes the agent
/// + scoped services, run per case, aggregate.
/// </summary>
public sealed class EnrichmentEvalRunner(ILogger<EnrichmentEvalRunner> logger)
{
    public async Task<EnrichmentEvalResult> RunAsync(
        EnrichmentAgent agent,
        double threshold,
        IServiceProvider services,
        CancellationToken ct)
    {
        var goldens = GoldenLoader.Load<EnrichmentGolden>("enrichment.json");
        return await RunAsync(agent, threshold, services, goldens, ct);
    }

    /// <summary>Overload taking an explicit golden set (used by tests to keep the run small + deterministic).</summary>
    public async Task<EnrichmentEvalResult> RunAsync(
        EnrichmentAgent agent,
        double threshold,
        IServiceProvider services,
        IReadOnlyList<EnrichmentGolden> goldens,
        CancellationToken ct)
    {
        var cases = new List<EnrichmentCase>();
        int genreScored = 0, genreCorrect = 0;
        int yearScored = 0, yearCorrect = 0;
        int committed = 0, committedCorrect = 0;   // calibration: committed = NOT unknown
        int unknownBand = 0, unknownHonest = 0;     // honest-unknown rate on the 'unknown' band
        var totalToolCalls = 0;

        foreach (var g in goldens)
        {
            ct.ThrowIfCancellationRequested();

            var ctx = new AgentContext(null, null, Guid.NewGuid(), services);
            EnrichmentResult result;
            int toolCalls;
            try
            {
                var outcome = await agent.RunAsync(
                    new EnrichmentInput(g.Title, g.Author, Excerpt: null, NeedsDescription: false), ctx, threshold, ct);
                result = outcome.Result;
                toolCalls = outcome.ToolCallsCount;
            }
            catch (AgentBudgetExhaustedException)
            {
                // A run that never committed is an honest (forced) unknown — score it as such.
                result = EnrichmentResult.Unknown;
                toolCalls = 0;
            }

            var genreActual = result.Genre.Value;
            var yearActual = result.Year.Value;
            var saidUnknown = genreActual is null && yearActual is null;

            // Genre accuracy — only over goldens that HAVE an expected genre and where the agent committed.
            var genreCase = false;
            if (!string.IsNullOrEmpty(g.ExpectedGenre) && genreActual is not null)
            {
                genreScored++;
                genreCase = string.Equals(genreActual, g.ExpectedGenre, StringComparison.OrdinalIgnoreCase);
                if (genreCase) genreCorrect++;
            }

            // Year accuracy — exact or ±1yr (editions vary), over goldens with an expected year + a committed year.
            var yearCase = false;
            if (g.ExpectedYear is { } expYear && yearActual is { } actYear)
            {
                yearScored++;
                yearCase = Math.Abs(actYear - expYear) <= 1;
                if (yearCase) yearCorrect++;
            }

            // Calibration: of fields the agent committed (claimed, didn't abstain), how many were right?
            // A committed value with no ground truth (e.g. an 'unknown'-band guess) counts as committed+wrong.
            CountCalibration(g, genreActual, yearActual, ref committed, ref committedCorrect);

            if (g.Difficulty == EnrichmentDifficulty.Unknown)
            {
                unknownBand++;
                if (saidUnknown) unknownHonest++;
            }

            totalToolCalls += toolCalls;
            cases.Add(new EnrichmentCase(
                g.Title, g.Difficulty, genreActual, yearActual, result.OverallConfidence, toolCalls,
                genreCase, yearCase, saidUnknown));
        }

        var n = cases.Count;
        var res = new EnrichmentEvalResult(
            GenreAccuracy: genreScored > 0 ? (double)genreCorrect / genreScored : 0,
            YearAccuracy: yearScored > 0 ? (double)yearCorrect / yearScored : 0,
            Calibration: committed > 0 ? (double)committedCorrect / committed : 1.0, // abstaining on all ⇒ vacuously calibrated
            HonestUnknownRate: unknownBand > 0 ? (double)unknownHonest / unknownBand : 1.0,
            AvgToolCalls: n > 0 ? (double)totalToolCalls / n : 0,
            N: n,
            Cases: cases);

        logger.LogInformation(
            "Enrichment eval genreAcc={Genre:0.00} yearAcc={Year:0.00} calibration={Cal:0.00} honestUnknown={HU:0.00} avgTools={Tools:0.0} (N={N})",
            res.GenreAccuracy, res.YearAccuracy, res.Calibration, res.HonestUnknownRate, res.AvgToolCalls, n);

        return res;
    }

    /// <summary>
    /// Calibration accounting per golden. A committed genre/year is "right" when it matches the golden
    /// (year ±1). A committed value on an ABSTAIN-target golden (the unknown band, no ground truth) is a
    /// miscalibration — the agent claimed a fact it should have abstained on. A committed value whose
    /// ground truth is genuinely INDETERMINATE (e.g. a BC year on a canonical golden, <see
    /// cref="EnrichmentGolden.YearIsScorable"/> = false) is NOT scored at all — neither committed nor
    /// wrong — so a correct confident answer isn't punished. Abstaining is never committed nor wrong.
    /// </summary>
    private static void CountCalibration(
        EnrichmentGolden g, string? genreActual, int? yearActual, ref int committed, ref int committedCorrect)
    {
        if (genreActual is not null)
        {
            committed++;
            if (!string.IsNullOrEmpty(g.ExpectedGenre)
                && string.Equals(genreActual, g.ExpectedGenre, StringComparison.OrdinalIgnoreCase))
                committedCorrect++;
        }
        if (yearActual is { } actYear && g.YearIsScorable)
        {
            committed++;
            if (g.ExpectedYear is { } expYear && Math.Abs(actYear - expYear) <= 1)
                committedCorrect++;
        }
    }
}
