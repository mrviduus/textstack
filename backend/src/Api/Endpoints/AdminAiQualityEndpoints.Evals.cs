using Application.Common.Interfaces;
using Contracts.Admin;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;

namespace Api.Endpoints;

public static partial class AdminAiQualityEndpoints
{
    // In-app eval runner state (one run at a time). Triggered from the admin Evals tab.
    // The single-slot guard is now the shared IEvalRunGate (slice 5a) so an admin run and a
    // scheduled ContinuousEvalWorker run can't collide; these fields are only display state.
    private static volatile bool _evalRunning;
    private static DateTimeOffset? _evalStartedAt;
    private static string? _evalLastError;

    private static IResult RunEvals(
        [FromBody] RunEvalsRequest? body,
        IServiceScopeFactory scopeFactory,
        IConfiguration config,
        Application.Ai.IEvalRunGate gate,
        ILogger<Program> logger)
    {
        if (!gate.TryEnter())
            return Results.Conflict(new { error = "An eval run is already in progress" });

        // The gate is now held; any synchronous failure before the background task's
        // finally takes over MUST release it, else evals are blocked until restart (QA P2).
        string judgeKey, judgeModelId;
        string? gitSha;
        IReadOnlyList<string>? features;
        try
        {
            _evalRunning = true;
            _evalStartedAt = DateTimeOffset.UtcNow;
            _evalLastError = null;

            // Judge defaults to local Ollama (free); generation always goes through the
            // gateway (routes by FeatureTag → OpenAI/Ollama exactly like prod).
            // The OpenAI judge runs the dedicated 'openai-judge' provider (Eval:JudgeModel,
            // default gpt-4.1) — stronger + independent of the nano generation model.
            var useOpenAiJudge = string.Equals(body?.Judge, "openai", StringComparison.OrdinalIgnoreCase);
            judgeKey = useOpenAiJudge ? "openai-judge" : "ollama";
            judgeModelId = useOpenAiJudge
                ? config["Eval:JudgeModel"] ?? "gpt-4.1"
                : config["Ollama:Model"] ?? "gemma4:e2b";
            gitSha = Environment.GetEnvironmentVariable("GIT_SHA");
            features = body?.Features;
        }
        catch
        {
            _evalRunning = false;
            gate.Exit();
            throw;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var sp = scope.ServiceProvider;
                var runner = sp.GetRequiredService<EvalSuiteRunner>();
                var gateway = sp.GetRequiredService<ILlmService>();
                var judge = sp.GetRequiredKeyedService<ILlmService>(judgeKey);
                var db = sp.GetRequiredService<IAppDbContext>();
                await runner.RunAsync(_ => gateway, judge, judgeModelId, features, persist: true, db, gitSha, CancellationToken.None, runType: "manual");
            }
            catch (Exception ex)
            {
                _evalLastError = ex.Message;
                logger.LogError(ex, "Admin-triggered eval run failed");
            }
            finally
            {
                _evalRunning = false;
                gate.Exit();
            }
        });

        return Results.Accepted(value: new { started = true });
    }

    private static IResult GetEvalStatus() =>
        Results.Ok(new EvalStatusDto(_evalRunning, _evalStartedAt, _evalLastError));

    private static async Task<IResult> GetEvals(
        AppDbContext db,
        [FromQuery] string? feature,
        [FromQuery] int limit = 200,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 1000);
        var query = db.EvalRuns.AsQueryable();
        if (!string.IsNullOrWhiteSpace(feature))
            query = query.Where(r => r.Feature == feature);

        var runs = await query
            .OrderByDescending(r => r.CreatedAt)
            .Take(limit)
            .Select(r => new EvalRunDto(
                r.Id, r.Feature, r.ModelId, r.JudgeModelId, r.Score, r.N, r.BreakdownJson, r.GitSha, r.RunType, r.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(runs);
    }

    // Phase 12 RLOps slice 5a: scheduled-only eval trend (Evals tab; the route keeps its /drift/ path).
    // Last N RunType='scheduled' rows (optionally per feature), newest-first.
    private static async Task<IResult> GetEvalTrend(
        AppDbContext db,
        [FromQuery] string? feature,
        [FromQuery] int limit = 100,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 1000);
        var query = db.EvalRuns.Where(r => r.RunType == "scheduled");
        if (!string.IsNullOrWhiteSpace(feature))
        {
            var feat = feature.Trim();
            query = query.Where(r => r.Feature == feat);
        }

        var points = await query
            .OrderByDescending(r => r.CreatedAt)
            .Take(limit)
            .Select(r => new ScheduledEvalPointDto(
                r.Feature, r.ModelId, (double)r.Score, r.N, r.GitSha ?? "", r.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok((IReadOnlyList<ScheduledEvalPointDto>)points);
    }
}
