using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Tools;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// AI eval-suite runners + the shared scheduled-eval gate/regression detector.
    /// All singletons — stateless over the singleton ILlmService gateway.
    /// </summary>
    public static IServiceCollection AddTextStackAiEvals(this IServiceCollection services)
    {
        services.AddSingleton<TextStack.Ai.EvalSuite.EvalSuiteRunner>();
        // Scheduled-eval support (Phase 12 RLOps slice 5a): shared single-slot overlap gate +
        // pure regression detector, consumed by both the admin trigger and ContinuousEvalWorker.
        services.AddSingleton<Application.Ai.IEvalRunGate, Application.Ai.EvalRunGate>();
        services.AddSingleton<Application.Ai.EvalRegressionDetector>();
        services.AddSingleton<TextStack.Ai.EvalSuite.ToolCallEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.EnrichmentEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.TutorEvalRunner>();
        return services;
    }

    /// <summary>
    /// Tool catalogue + agent-loop engine + concrete agents.
    /// Scoped agents resolve scoped IAppDbContext per request.
    /// </summary>
    public static IServiceCollection AddTextStackAgents(this IServiceCollection services)
    {
        // Tool catalogue (AI-029/030): scans Application for ITool impls; dispatch is schema-validated.
        services.AddAiTools(typeof(Application.Tools.GetChapterTool).Assembly);
        // Agent loop engine (Phase 6, AI-034). Concrete agents build on it.
        TextStack.Ai.Agents.ServiceCollectionExtensions.AddAiAgents(services);
        // Enrichment agent (AI-Agent-1): registered in the API too so the admin eval path can run it.
        services.AddScoped<Application.Agents.EnrichmentAgent>();
        // Learning Tutor agent (AI-Agent-2): plans an ordered study set over the learner's SRS + reading state and
        // hands off to the existing vocabulary-review flow. Scoped (its tools resolve the scoped IAppDbContext
        // per request).
        services.AddScoped<Application.Agents.TutorAgent>();
        return services;
    }
}
