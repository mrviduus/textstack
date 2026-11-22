using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Tools;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Tool catalogue + agent-loop engine.
    /// </summary>
    public static IServiceCollection AddTextStackAgents(this IServiceCollection services)
    {
        // Tool catalogue (AI-029/030): scans Application for ITool impls; dispatch is schema-validated.
        services.AddAiTools(typeof(Application.Tools.OpenLibrarySearchTool).Assembly);
        // Open Library tools only GET, so retries are safe; budget matches the tools' 10s client timeout.
        services.AddHttpClient(Application.Tools.OpenLibrarySearchTool.HttpClientName)
            .AddStandardResilienceHandler(o =>
            {
                o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(3);
                o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(10);
            });
        // Agent loop engine (Phase 6, AI-034). Concrete agents build on it.
        TextStack.Ai.Agents.ServiceCollectionExtensions.AddAiAgents(services);
        return services;
    }
}
