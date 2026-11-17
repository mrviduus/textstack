using Application.Agents;
using Application.Common.Interfaces;
using Contracts.Admin;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;
using TextStack.Ai.Llm;
using TextStack.Ai.Tools;

namespace Api.Endpoints;

public static partial class AdminAiQualityEndpoints
{
    // AI-Agent-1 DoD gate: runs the REAL EnrichmentAgent over the enrichment golden set and scores
    // genre/year accuracy, the headline CALIBRATION metric (committed ⇒ correct), the honest-unknown
    // rate, and avg tool calls. Generation goes through the gateway (routed by FeatureTag bookmeta.agent
    // → the configured model, e.g. gpt-4.1-mini); the agent's tools hit Open Library. Deterministic
    // scoring (no judge — ground truth is in the golden). Needs a key; ~30 model calls + tool calls,
    // run sync like the other eval gates. This is the path that validates the calibration claim on a real
    // model. Threshold = Enrichment:ConfidenceThreshold (default 0.7), matching the Worker.
    private static async Task<IResult> RunEnrichmentEval(
        HttpContext httpContext,
        IServiceProvider services,
        IConfiguration config,
        EnrichmentEvalRunner runner,
        EnrichmentAgent agent,
        CancellationToken ct)
    {
        try
        {
            // The agent resolves its ILlmService through the gateway when it runs; probe it here so a
            // keyless host returns a clean 503 instead of failing deep in the loop.
            _ = services.GetRequiredService<ILlmService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway is not configured (no OpenAI key).", statusCode: 503);
        }

        var threshold = config.GetValue("Enrichment:ConfidenceThreshold", 0.7);
        // The agent's tools resolve scoped services (IHttpClientFactory) from the request scope.
        var result = await runner.RunAsync(agent, threshold, httpContext.RequestServices, ct);

        return Results.Ok(new
        {
            genreAccuracy = Math.Round(result.GenreAccuracy, 3),
            yearAccuracy = Math.Round(result.YearAccuracy, 3),
            calibration = Math.Round(result.Calibration, 3),
            honestUnknownRate = Math.Round(result.HonestUnknownRate, 3),
            avgToolCalls = Math.Round(result.AvgToolCalls, 2),
            n = result.N,
            cases = result.Cases.Select(c => new
            {
                c.Title,
                c.Difficulty,
                c.GenreActual,
                c.YearActual,
                confidence = Math.Round(c.Confidence, 3),
                c.ToolCalls,
                c.GenreCorrect,
                c.YearCorrect,
                c.SaidUnknown,
            }),
        });
    }

    // AI-Agent-2 DoD gate: runs the REAL TutorAgent over the synthetic tutor golden states (an SRS snapshot +
    // reading context per case, served by fake tools) and scores the structural rubric DETERMINISTICALLY (no
    // judge — there is no single ground-truth plan): due-coverage, weak-targeting, difficulty-appropriateness,
    // the hard NO-HALLUCINATION guarantee (every planned wordId exists in the state), and thesis-alignment
    // (bounded plan + reading nudge). Planning goes through the gateway (FeatureTag tutor.agent → gpt-4.1-mini);
    // the tools are fakes, so the only non-determinism is the model. Needs a key; run sync like the others.
    private static async Task<IResult> RunTutorEval(
        IServiceProvider services,
        TutorEvalRunner runner,
        CancellationToken ct)
    {
        ILlmService llm;
        try
        {
            llm = services.GetRequiredService<ILlmService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway is not configured (no OpenAI key).", statusCode: 503);
        }

        var result = await runner.RunAsync(llm, ct);

        return Results.Ok(new
        {
            dueCoverage = Math.Round(result.DueCoverage, 3),
            weakTargeting = Math.Round(result.WeakTargeting, 3),
            difficultyAppropriateness = Math.Round(result.DifficultyAppropriateness, 3),
            noHallucinationRate = Math.Round(result.NoHallucinationRate, 3),
            thesisAlignment = Math.Round(result.ThesisAlignment, 3),
            avgToolCalls = Math.Round(result.AvgToolCalls, 2),
            n = result.N,
            cases = result.Cases.Select(c => new
            {
                c.Name,
                c.Planned,
                dueCoverage = Math.Round(c.DueCoverage, 3),
                weakTargeting = Math.Round(c.WeakTargeting, 3),
                c.DifficultyAppropriate,
                c.NoHallucination,
                c.ThesisAligned,
                c.ToolCalls,
            }),
        });
    }

    // Phase 5 DoD gate (AI-033): deterministic tool-call accuracy over the embedded golden set.
    // Round-1 only (tools are never executed) → no edition/user needed; ~30 nano calls, run sync.
    private static async Task<IResult> RunToolCallEval(
        IServiceProvider services,
        ToolCallEvalRunner runner,
        IToolRegistry registry,
        IAppDbContext db,
        CancellationToken ct)
    {
        ILlmService llm;
        try
        {
            llm = services.GetRequiredService<ILlmService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway is not configured (no OpenAI key).", statusCode: 503);
        }

        var gitSha = Environment.GetEnvironmentVariable("GIT_SHA");
        var result = await runner.RunAsync(llm, registry, persist: true, db, gitSha, ct);

        return Results.Ok(new
        {
            accuracy = Math.Round(result.Accuracy, 4),
            n = result.N,
            cases = result.Cases.Select(c => new
            {
                c.Word,
                expected = c.ExpectedTool ?? "(no tool)",
                actual = c.ActualTools,
                c.Hit,
            }),
        });
    }
}
