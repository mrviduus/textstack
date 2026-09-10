namespace Api.Endpoints;

/// <summary>
/// AI observability dashboard (AI-008, Summary tab). Aggregates the sampled
/// <c>llm_trace</c> rows into per-feature cost / latency (p50,p95) / error-rate /
/// volume over a time window. Admin-only via the AdminAuth middleware (all
/// <c>/admin/*</c>). Judge-score trends arrive once eval runs persist (AI-010).
///
/// Routes registered via <see cref="MapAdminAiQualityEndpoints"/>; handlers are split
/// across partial files by sub-domain to keep each file reviewable:
///
///   - AdminAiQualityEndpoints.Summary.cs      GetSummary + raw-SQL row types
///   - AdminAiQualityEndpoints.Traces.cs       GetTraces, GetTrace, GetAgentRuns, GetAgentRun
///   - AdminAiQualityEndpoints.Evals.cs        RunEvals, GetEvalStatus, GetEvals, GetEvalTrend, GetDrift
///   - AdminAiQualityEndpoints.EvalRunners.cs  per-agent/crew eval trigger endpoints
///   - AdminAiQualityEndpoints.Shadow.cs       GetShadowSummary, ToPairDto, GetShadowSamples
///   - AdminAiQualityEndpoints.Models.cs       GetModels, PromoteModel, RollbackModel
///   - AdminAiQualityEndpoints.Budgets.cs      GetBudgets
///
/// Splits use C# `partial` — compile-identical to the original monolithic file.
/// </summary>
public static partial class AdminAiQualityEndpoints
{
    public static void MapAdminAiQualityEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/ai-quality").WithTags("AI Quality");
        group.MapGet("/summary", GetSummary);
        group.MapGet("/traces", GetTraces);
        group.MapGet("/traces/{id:guid}", GetTrace);
        group.MapGet("/agent-runs", GetAgentRuns);
        group.MapGet("/agent-runs/{id:guid}", GetAgentRun);
        group.MapGet("/evals", GetEvals);
        group.MapGet("/drift/eval-trend", GetEvalTrend);
        group.MapGet("/drift", GetDrift);
        group.MapPost("/evals/run", RunEvals);
        group.MapGet("/evals/status", GetEvalStatus);
        group.MapPost("/evals/toolcalls/run", RunToolCallEval);
        group.MapPost("/enrichment/eval", RunEnrichmentEval);
        group.MapPost("/tutor/eval", RunTutorEval);
        group.MapPost("/evals/criticdefects/run", RunCriticDefectEval);
        group.MapPost("/evals/crew-ab/run", RunCrewAbEval);
        group.MapGet("/shadow/summary", GetShadowSummary);
        group.MapGet("/shadow/samples", GetShadowSamples);
        group.MapGet("/models", GetModels);
        group.MapPost("/models/{id:guid}/promote", PromoteModel);
        group.MapPost("/models/{feature}/rollback", RollbackModel);
        group.MapGet("/budgets", GetBudgets);
    }
}
