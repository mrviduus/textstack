using Application.Agents;
using Application.Common.Interfaces;
using Application.Rag;
using Contracts.Admin;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;
using TextStack.Ai.Rag;
using TextStack.Ai.Tools;

namespace Api.Endpoints;

public static partial class AdminAiQualityEndpoints
{
    // Phase 7 DoD gate (AI-046): A/B the single-call baseline vs the full FieldCrew on the same brief+source over
    // the golden set, judged by an independent stronger judge (gpt-4.1). Reports crew lift % + cost ratio and
    // gates on lift ≥ 0.10 AND costRatio ≤ 2.0. Generation goes through the gateway (same nano for both arms);
    // the judge runs the dedicated openai-judge provider. ~30 gen + 20 judge calls, run sync like the others.
    private static async Task<IResult> RunCrewAbEval(
        HttpContext httpContext,
        IServiceProvider services,
        IConfiguration config,
        TextStack.Ai.EvalSuite.CrewAbEvalRunner runner,
        FieldCrew crew,
        IAppDbContext db,
        CancellationToken ct)
    {
        ILlmService gateway;
        try
        {
            gateway = services.GetRequiredService<ILlmService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway is not configured (no OpenAI key).", statusCode: 503);
        }

        ILlmService judge;
        try
        {
            judge = services.GetRequiredKeyedService<ILlmService>("openai-judge");
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("Judge LLM is not configured.", statusCode: 503);
        }

        var judgeModelId = config["Eval:JudgeModel"] ?? "gpt-4.1";
        var baseline = new BaselineFieldAgent(gateway);
        var gitSha = Environment.GetEnvironmentVariable("GIT_SHA");

        var result = await runner.RunAsync(
            baseline, crew, judge, judgeModelId, persist: true, db, gitSha, ct);

        return Results.Ok(new
        {
            avgA = Math.Round(result.AvgA, 3),
            avgB = Math.Round(result.AvgB, 3),
            liftPct = Math.Round(result.LiftPct, 4),
            costRatio = double.IsPositiveInfinity(result.CostRatio) ? (double?)null : Math.Round(result.CostRatio, 3),
            winRate = Math.Round(result.WinRate, 3),
            n = result.N,
            passed = result.Passed,
            cases = result.Cases.Select(c => new
            {
                c.Id,
                scoreA = Math.Round(c.JudgeScoreA, 3),
                scoreB = Math.Round(c.JudgeScoreB, 3),
                c.CostA,
                c.CostB,
                c.BWins,
            }),
        });
    }

    // Phase 7 DoD gate (AI-044): inject KNOWN defects into clean drafts, run the REAL AI-041 critic (nano)
    // over each, and measure per-axis + overall catch-rate vs the ≥0.80 gate plus a clean-control
    // false-positive rate. Deterministic injection + scoring; ~23 nano calls, run sync like the others.
    private static async Task<IResult> RunCriticDefectEval(
        IServiceProvider services,
        CriticDefectEvalRunner runner,
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

        var critic = new CriticAgent(llm);
        var gitSha = Environment.GetEnvironmentVariable("GIT_SHA");
        var result = await runner.RunAsync(critic, persist: true, db, gitSha, ct);

        return Results.Ok(new
        {
            catchRate = Math.Round(result.CatchRate, 4),
            falsePositiveRate = Math.Round(result.FalsePositiveRate, 4),
            n = result.N,
            passed = result.Passed,
            cases = result.Cases.Select(c => new
            {
                c.Id,
                c.DefectType,
                expectedAxis = c.ExpectedAxis ?? "(clean control)",
                c.Caught,
                c.Flagged,
                c.ParseFailed,
            }),
        });
    }

    // ADR-012 S3 DoD gate: runs the PDF vision-RAG eval over the embedded SYNTHETIC table-page fixtures —
    // self-contained (no seeded book, no DB pollution). Transcribes each page through the gateway pdf.parse
    // route (→ gpt-4.1) with the shared PdfVisionPrompt, judges transcription + answer fidelity (1–5), and
    // deterministically scores page-citation + table-structure survival. `judge` = openai (default,
    // Eval:JudgeModel) | ollama. Persists pdfvision.transcription / .answer / .citation / .tablestructure
    // EvalRun rows. Needs a key (gateway ILlmService + IEmbeddingService throw keyless) — the scored run
    // happens on prod; keyless hosts get a clean 503. Admin-triggered only; NOT scheduled.
    private static async Task<IResult> RunPdfVisionEval(
        [FromQuery] string? judge,
        IServiceProvider services,
        IConfiguration config,
        PdfVisionEvalRunner runner,
        IAppDbContext db,
        CancellationToken ct)
    {
        ILlmService vision;
        IEmbeddingService embedder;
        IRagAskService ask;
        try
        {
            // The gateway (vision route) + embedder both construct from the OpenAI key; probe them here so a
            // keyless host returns a clean 503 instead of failing deep in transcription/retrieval.
            vision = services.GetRequiredService<ILlmService>();
            embedder = services.GetRequiredService<IEmbeddingService>();
            ask = services.GetRequiredService<IRagAskService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway / embeddings are not configured (no OpenAI key).", statusCode: 503);
        }

        var useOllama = string.Equals(judge, "ollama", StringComparison.OrdinalIgnoreCase);
        var judgeKey = useOllama ? "ollama" : "openai-judge";
        var judgeModelId = useOllama ? config["Ollama:Model"] ?? "gemma4:e2b" : config["Eval:JudgeModel"] ?? "gpt-4.1";

        ILlmService judgeClient;
        try
        {
            judgeClient = services.GetRequiredKeyedService<ILlmService>(judgeKey);
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("Judge LLM is not configured.", statusCode: 503);
        }

        var gitSha = Environment.GetEnvironmentVariable("GIT_SHA");
        var result = await runner.RunAsync(
            vision, embedder, ask, judgeClient, judgeModelId, k: IRagService.DefaultK,
            persist: true, db, gitSha, ct);

        return Results.Ok(new PdfVisionEvalDto(
            Math.Round(result.Transcription, 3),
            Math.Round(result.Answer, 3),
            Math.Round(result.Citation, 4),
            Math.Round(result.TableStructure, 4),
            result.PageN,
            result.QaN,
            result.PageCases.Select(c => new PdfVisionPageDto(
                c.Page, c.Transcribed, Math.Round(c.JudgeScore, 3), c.TableSurvived)).ToList(),
            result.QaCases.Select(c => new PdfVisionQaDto(
                c.Question, c.ExpectedPage, Math.Round(c.AnswerScore, 3), c.CitedExpectedPage, c.CitedPages, c.Insufficient)).ToList(),
            result.Note));
    }

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

    // AI-Agent-3 DoD gate: runs the REAL LibrarianAgent over the librarian golden set and scores recall@k,
    // constraint-satisfaction (returned library books respect language/length), coverage-decision accuracy
    // (expand to Open Library exactly when the library is thin), and the hallucination invariant (every
    // returned library slug genuinely exists in the catalog). Generation goes through the gateway (routed by
    // FeatureTag librarian.agent → gpt-4.1-mini); the agent's tools hit the live catalog search + DB + Open
    // Library. Deterministic scoring (no judge — relevance labels are in the golden). Needs a key; run sync.
    private static async Task<IResult> RunLibrarianEval(
        HttpContext httpContext,
        IServiceProvider services,
        LibrarianEvalRunner runner,
        LibrarianAgent agent,
        IAppDbContext db,
        CancellationToken ct)
    {
        try
        {
            _ = services.GetRequiredService<ILlmService>();
        }
        catch (InvalidOperationException)
        {
            return Results.Problem("LLM gateway is not configured (no OpenAI key).", statusCode: 503);
        }

        // Hallucination probe: confirm a returned library slug is genuinely a published catalog entry.
        Task<bool> SlugExists(string slug, CancellationToken token) =>
            db.Editions.AnyAsync(e => e.Slug == slug, token);

        var result = await runner.RunAsync(agent, httpContext.RequestServices, SlugExists, ct);

        return Results.Ok(new
        {
            recallAtK = Math.Round(result.RecallAtK, 3),
            precisionAtK = Math.Round(result.PrecisionAtK, 3),
            f1AtK = Math.Round(result.F1AtK, 3),
            constraintSatisfaction = Math.Round(result.ConstraintSatisfaction, 3),
            coverageDecisionAccuracy = Math.Round(result.CoverageDecisionAccuracy, 3),
            hallucinationFreeRate = Math.Round(result.HallucinationFreeRate, 3),
            avgToolCalls = Math.Round(result.AvgToolCalls, 2),
            n = result.N,
            cases = result.Cases.Select(c => new
            {
                c.Query,
                c.Returned,
                c.LibraryReturned,
                recallAtK = Math.Round(c.RecallAtK, 3),
                precisionAtK = Math.Round(c.PrecisionAtK, 3),
                f1AtK = Math.Round(c.F1AtK, 3),
                c.ConstraintsSatisfied,
                c.CoverageDecisionCorrect,
                c.NoHallucination,
                c.ToolCalls,
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
