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
        services.AddSingleton<TextStack.Ai.EvalSuite.RagEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.UserBookRagEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.PdfVisionEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.ToolCallEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.EnrichmentEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.TutorEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.CriticDefectEvalRunner>();
        services.AddSingleton<TextStack.Ai.EvalSuite.CrewAbEvalRunner>();
        return services;
    }

    /// <summary>
    /// Tool catalogue + agent-loop engine + concrete agents and content crews.
    /// Lifetimes mirror Program.cs exactly (scoped agents resolve scoped IAppDbContext /
    /// IRagService per request; stateless single-call specialists are singletons).
    /// </summary>
    public static IServiceCollection AddTextStackAgents(this IServiceCollection services)
    {
        // Tool catalogue (AI-029/030): scans Application for ITool impls; dispatch is schema-validated.
        services.AddAiTools(typeof(Application.Tools.GetChapterTool).Assembly);
        // Agent loop engine (Phase 6, AI-034). Concrete agents build on it.
        TextStack.Ai.Agents.ServiceCollectionExtensions.AddAiAgents(services);
        // Enrichment agent (AI-Agent-1): registered in the API too so the admin eval path can run it.
        services.AddScoped<Application.Agents.EnrichmentAgent>();
        // Catalog search seam behind the library tools. Scoped: resolves the scoped IAppDbContext.
        services.AddScoped<Application.Search.LibrarySearchService>();
        // Learning Tutor agent (AI-Agent-2): plans an ordered study set over the learner's SRS + reading state and
        // hands off to the existing vocabulary-review flow. Scoped (its tools resolve the scoped IAppDbContext +
        // IRagService per request).
        services.AddScoped<Application.Agents.TutorAgent>();
        // Crew specialists (Phase 7, AI-041): single-call IAgent<TIn,TOut> sub-agents the content crews
        // (AI-042/043) compose via CrewTasks.Of. Stateless + ILlmService is a singleton, so singleton is fine.
        services.AddSingleton<Application.Agents.ResearcherAgent>();
        services.AddSingleton<Application.Agents.DrafterAgent>();
        services.AddSingleton<Application.Agents.CriticAgent>();
        services.AddSingleton<Application.Agents.EditorAgent>();
        // Single-call A/B baseline (Phase 7, AI-046): the "A" arm of the crew-vs-single-call eval — one ILlmService
        // call that writes a field directly under the crew's full brief contract. Stateless singleton like the specialists.
        services.AddSingleton<Application.Agents.BaselineFieldAgent>();
        // AutoPublish crew (Phase 7, AI-042): in-process admin path that runs the specialists over ILlmService to
        // generate SEO prose for an Edition. Scoped because it persists via the scoped IAgentRunWriter (per-request
        // DbContext). The legacy bash + Claude-CLI poller stays the default; this is the observable, traced alternative.
        // Shared per-field crew runner (Phase 7, AI-043): the 4-stage plan + fail-closed gate + agent_run persistence,
        // extracted from AutoPublishCrew so both AutoPublish and SEO crews delegate to it. Scoped (scoped IAgentRunWriter).
        services.AddScoped<Application.Agents.FieldCrew>();
        services.AddScoped<Application.Agents.AutoPublishCrew>();
        // SEO crew (Phase 7, AI-043): in-process admin path that generates ONE SEO prose field over ILlmService and
        // routes it through the SeoBackfillJob apply path. The legacy seo-backfill poller stays the default + untouched.
        services.AddScoped<Application.Agents.SeoCrew>();
        return services;
    }
}
