using Application.Ai;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace TextStack.Ai.EvalSuite;

/// <summary>One golden's outcome — what the model actually called, for the admin UI.</summary>
public sealed record ToolCallCase(string Word, string? ExpectedTool, IReadOnlyList<string> ActualTools, bool Hit);

/// <summary>Result of a tool-call eval run (AI-033). DoD: accuracy ≥ 0.9 over the 30-case set.</summary>
public sealed record ToolCallEvalResult(double Accuracy, int N, IReadOnlyList<ToolCallCase> Cases);

/// <summary>
/// Runs the Phase 5 tool-call eval (AI-033): for each golden, issue the REAL Explain round-1 — the
/// production prompt (<see cref="ExplainPrompt"/> with tool guidance) + the registry's tool schemas —
/// and score the model's tool choice with the pure <see cref="ToolCallMetrics"/> (right tool, right
/// args, or correctly NO tool). Round 1 only: tools are never executed, so the eval needs no edition,
/// no user, and costs one nano call per case.
/// </summary>
public sealed class ToolCallEvalRunner(ILogger<ToolCallEvalRunner> logger)
{
    private const string Feature = "explain.toolcall";
    private const int MaxOutputTokens = 500; // matches the Explain endpoint's round-1 budget

    public async Task<ToolCallEvalResult> RunAsync(
        ILlmService llm,
        IToolRegistry registry,
        CancellationToken ct)
    {
        var goldens = ToolCallGoldenSet.Load();

        var cases = new List<ToolCallCase>();
        string? modelId = null;
        foreach (var g in goldens)
        {
            ct.ThrowIfCancellationRequested();

            // Mirror production exactly (the gate measures the PIPELINE, not the bare model): the
            // deterministic pre-router decides which tools — if any — ride along for this sentence;
            // a no-signal sentence carries no schemas, so the model cannot over-call (AI-033).
            var names = ExplainToolTriggers.TriggeredTools(g.Sentence, hasUser: true);
            var tools = names.Count == 0 ? null : registry.SchemasFor(names);
            var systemPrompt = ExplainPrompt.BuildSystemPrompt(
                genre: null, targetLang: "en", withTools: tools is { Count: > 0 });

            var request = new LlmRequest(
                systemPrompt,
                [new LlmMessage("user", ExplainPrompt.BuildUserPrompt(g.Word, g.Sentence))],
                MaxOutputTokens, Tools: tools, FeatureTag: Feature);

            var response = await llm.CompleteAsync(request, ct);
            modelId ??= response.ModelId;

            var hit = ToolCallMetrics.IsHit(response.ToolCalls, g.ExpectedTool, g.ExpectedArgFragments);
            cases.Add(new ToolCallCase(
                g.Word, g.ExpectedTool, response.ToolCalls.Select(c => c.ToolName).ToList(), hit));
        }

        var accuracy = ToolCallMetrics.Accuracy(cases.Select(c => c.Hit).ToList());
        logger.LogInformation("Tool-call eval: accuracy={Accuracy:0.00} (N={N})", accuracy, cases.Count);

        return new ToolCallEvalResult(accuracy, cases.Count, cases);
    }
}
