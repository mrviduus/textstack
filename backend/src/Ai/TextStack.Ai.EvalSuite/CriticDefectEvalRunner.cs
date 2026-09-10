using System.Globalization;
using System.Text;
using Application.Agents;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;

namespace TextStack.Ai.EvalSuite;

/// <summary>One golden's outcome for the admin UI: was the injected defect caught (or the control flagged)?</summary>
/// <param name="Id">The golden's stable id.</param>
/// <param name="DefectType">The injected defect (or <c>clean</c> for a control).</param>
/// <param name="ExpectedAxis">The axis that should fire (null for controls).</param>
/// <param name="Caught">Defect cases: the critic caught the planted defect.</param>
/// <param name="Flagged">Control cases: the critic (wrongly) flagged the clean draft → a false positive.</param>
/// <param name="ParseFailed">The critic's output was unparseable (fail-closed reject).</param>
public sealed record CriticDefectCase(
    string Id, string DefectType, string? ExpectedAxis, bool Caught, bool Flagged, bool ParseFailed);

/// <summary>
/// Result of a synthetic-defect run (AI-044). <see cref="CatchRate"/> = caught / total defects;
/// <see cref="FalsePositiveRate"/> = flagged controls / controls. BOTH gate <see cref="Passed"/> — a critic
/// that catches everything by flagging everything is not calibrated, so the gate demands precision too.
/// </summary>
public sealed record CriticDefectEvalResult(
    double CatchRate, double FalsePositiveRate, int N, IReadOnlyList<CriticDefectCase> Cases)
{
    /// <summary>Minimum share of planted defects the critic must catch.</summary>
    public const double CatchRateGate = 0.80;

    /// <summary>Maximum share of clean controls the critic may (wrongly) flag — keeps the gate honest.</summary>
    public const double FalsePositiveGate = 0.20;

    /// <summary>
    /// The Phase 7 calibration gate: catch ≥80% of planted defects AND falsely flag ≤20% of clean controls.
    /// A flag-everything critic (FP=1.0) catches every defect but fails this gate — calibration, not coverage.
    /// </summary>
    public bool Passed => CatchRate >= CatchRateGate && FalsePositiveRate <= FalsePositiveGate;
}

/// <summary>
/// Runs the Phase 7 synthetic-defect harness (AI-044): inject a KNOWN defect into each clean golden draft
/// (<see cref="CriticDefectInjector"/>, pure) → run the REAL AI-041 <see cref="CriticAgent"/> (nano) over it →
/// score with the pure classifier below (no judge). A defect is "caught" when the critic scores its expected
/// axis ≤2 (1–5, 1=worst), OR raises a blocker/major issue on that axis, OR fails to parse (fail-closed reject
/// counts as caught for ANY defect). A clean control is "flagged" (→ a false positive) on any blocker issue,
/// any axis ≤2, or a parse failure. Persists a <c>criticdefects</c> <see cref="EvalRun"/> (Score = catch-rate,
/// JudgeModelId = "n/a") so /ai-quality tracks critic calibration like every other feature. Mirrors
/// <see cref="ToolCallEvalRunner"/>: real model per case, pure scoring, sync (~23 nano calls).
/// </summary>
public sealed class CriticDefectEvalRunner(ILogger<CriticDefectEvalRunner> logger)
{
    private const string Feature = "criticdefects";

    /// <summary>The critic axes, keyed by the golden's <c>ExpectedAxis</c> string.</summary>
    private const string AxisFactual = "factual_accuracy";
    private const string AxisTone = "tone";
    private const string AxisLength = "length";
    private const string AxisBanned = "banned_phrases";

    /// <summary>An axis score at or below this (on the 1–5 scale, 1=worst) reads as "the critic rejected it".</summary>
    private const int RejectThreshold = 2;

    public async Task<CriticDefectEvalResult> RunAsync(
        CriticAgent critic,
        bool persist,
        IAppDbContext? db,
        string? gitSha,
        CancellationToken ct)
    {
        var goldens = CriticDefectGoldenSet.Load();
        var brief = AutoPublishBriefs.Description("en");

        // SingleCallAgent ignores ctx.Services (no tools), so an empty provider is enough — the critic
        // routes its own gateway call by FeatureTag exactly like prod.
        var agentCtx = new AgentContext(UserId: null, EditionId: null, Guid.NewGuid(), EmptyServiceProvider.Instance);

        var cases = new List<CriticDefectCase>();
        foreach (var g in goldens)
        {
            ct.ThrowIfCancellationRequested();

            var injected = CriticDefectInjector.Inject(g, brief);
            var input = new CritiqueInput(brief, new Draft(injected), new ResearchNotes(g.ResearchNotes));

            var verdict = (await critic.RunAsync(input, agentCtx, ct)).Output;

            var isControl = g.ExpectedAxis is null;
            var caught = !isControl && IsCaught(verdict, g.ExpectedAxis!);
            var flagged = isControl && IsFlagged(verdict);
            cases.Add(new CriticDefectCase(
                g.Id, g.DefectType, g.ExpectedAxis, caught, flagged, verdict.ParseFailed));
        }

        var defects = cases.Where(c => c.ExpectedAxis is not null).ToList();
        var controls = cases.Where(c => c.ExpectedAxis is null).ToList();

        var catchRate = defects.Count == 0 ? 0.0 : (double)defects.Count(c => c.Caught) / defects.Count;
        var falsePositiveRate =
            controls.Count == 0 ? 0.0 : (double)controls.Count(c => c.Flagged) / controls.Count;

        logger.LogInformation(
            "Critic-defect eval: catchRate={CatchRate:0.00} fpRate={FpRate:0.00} (defects={D}, controls={C})",
            catchRate, falsePositiveRate, defects.Count, controls.Count);

        if (persist && db is not null)
        {
            db.EvalRuns.Add(new EvalRun
            {
                Id = Guid.NewGuid(),
                Feature = Feature,
                ModelId = "crew.critic", // the agent does not surface its routed model id
                JudgeModelId = "n/a", // deterministic injection + scoring, no judge
                Score = Math.Round((decimal)catchRate, 3),
                N = cases.Count,
                BreakdownJson = BuildBreakdown(defects, controls, falsePositiveRate),
                GitSha = gitSha,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync(ct);
        }

        return new CriticDefectEvalResult(catchRate, falsePositiveRate, cases.Count, cases);
    }

    /// <summary>
    /// PRIMARY: the expected axis scored ≤2. FALLBACK: a blocker/major issue keyword-matched to the axis
    /// (factual/banned have distinctive language in Location/Fix). A parse failure counts as caught for ANY
    /// defect — an unreadable critic is a (correct) fail-closed reject of a defective draft.
    /// </summary>
    private static bool IsCaught(CritiqueResult v, string axis)
    {
        if (v.ParseFailed)
            return true;

        if (AxisScore(v, axis) <= RejectThreshold)
            return true;

        return v.Issues.Any(i => IsSevere(i.Severity) && IssueMatchesAxis(i, axis));
    }

    /// <summary>A clean control is flagged (false positive) on any blocker issue, any axis ≤2, or a parse failure.</summary>
    private static bool IsFlagged(CritiqueResult v) =>
        v.ParseFailed
        || v.Issues.Any(i => string.Equals(i.Severity, "blocker", StringComparison.OrdinalIgnoreCase))
        || v.FactualAccuracy <= RejectThreshold
        || v.Tone <= RejectThreshold
        || v.Length <= RejectThreshold
        || v.BannedPhrases <= RejectThreshold;

    private static int AxisScore(CritiqueResult v, string axis) => axis switch
    {
        AxisFactual => v.FactualAccuracy,
        AxisTone => v.Tone,
        AxisLength => v.Length,
        AxisBanned => v.BannedPhrases,
        _ => 5,
    };

    private static bool IsSevere(string severity) =>
        string.Equals(severity, "blocker", StringComparison.OrdinalIgnoreCase)
        || string.Equals(severity, "major", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Keyword-match an issue to the defect axis via its Location/Fix text. Factual + banned issues carry
    /// distinctive language; length/tone rely on the per-axis score (above) since their issue text varies.
    /// </summary>
    private static bool IssueMatchesAxis(CritiqueIssue issue, string axis)
    {
        var text = $"{issue.Location} {issue.Fix}".ToLowerInvariant();
        return axis switch
        {
            AxisFactual => text.Contains("fact") || text.Contains("unsupported")
                || text.Contains("not in") || text.Contains("hallucinat") || text.Contains("ungrounded"),
            AxisBanned => text.Contains("banned") || text.Contains("superlative")
                || text.Contains("phrase"),
            AxisLength => text.Contains("length") || text.Contains("long")
                || text.Contains("short") || text.Contains("char"),
            AxisTone => text.Contains("tone") || text.Contains("voice")
                || text.Contains("first-person") || text.Contains("casual") || text.Contains("marketing"),
            _ => false,
        };
    }

    private static string BuildBreakdown(
        IReadOnlyList<CriticDefectCase> defects,
        IReadOnlyList<CriticDefectCase> controls,
        double falsePositiveRate)
    {
        var sb = new StringBuilder();
        sb.Append('{');

        // per-axis catch-rate (over each axis's defect cases)
        sb.Append("\"perAxisCatchRate\":{");
        var axisGroups = defects
            .GroupBy(c => c.ExpectedAxis!)
            .OrderBy(grp => grp.Key, StringComparer.Ordinal)
            .ToList();
        for (var i = 0; i < axisGroups.Count; i++)
        {
            var grp = axisGroups[i];
            var rate = (double)grp.Count(c => c.Caught) / grp.Count();
            if (i > 0)
                sb.Append(',');
            sb.Append('"').Append(grp.Key).Append("\":").Append(Num(rate));
        }
        sb.Append("},");

        // counts per defect type
        sb.Append("\"countsByType\":{");
        var typeGroups = defects.Concat(controls)
            .GroupBy(c => c.DefectType)
            .OrderBy(grp => grp.Key, StringComparer.Ordinal)
            .ToList();
        for (var i = 0; i < typeGroups.Count; i++)
        {
            var grp = typeGroups[i];
            if (i > 0)
                sb.Append(',');
            sb.Append('"').Append(grp.Key).Append("\":").Append(grp.Count());
        }
        sb.Append("},");

        sb.Append("\"falsePositiveRate\":").Append(Num(falsePositiveRate)).Append(',');
        sb.Append("\"controls\":").Append(controls.Count).Append(',');
        sb.Append("\"defects\":").Append(defects.Count);
        sb.Append('}');
        return sb.ToString();
    }

    private static string Num(double value) =>
        Math.Round(value, 3).ToString("0.###", CultureInfo.InvariantCulture);

    /// <summary>No-service provider for the critic's <see cref="AgentContext"/> — SingleCallAgent never resolves tools.</summary>
    private sealed class EmptyServiceProvider : IServiceProvider
    {
        public static readonly EmptyServiceProvider Instance = new();
        public object? GetService(Type serviceType) => null;
    }
}
