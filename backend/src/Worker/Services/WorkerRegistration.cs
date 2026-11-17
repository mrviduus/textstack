using Infrastructure.Persistence;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Tools;

namespace Worker.Services;

public static class WorkerRegistration
{
    public static IServiceCollection AddSelectedWorkerLoops(this IServiceCollection services, IConfiguration config,
        DatabaseMode mode, string legacyConnectionString)
    {
        // First: queue consumers never start before the single-consumer lock is held on the active database.
        var connection = mode.IsV2 ? config.GetConnectionString("V2")! : legacyConnectionString;
        services.AddHostedService(sp => new SingleInstanceLock(connection, sp.GetRequiredService<ILogger<SingleInstanceLock>>()));
        services.AddHostedService<AiProviderReadinessCheck>();
        if (!mode.IsV2)
        {
            services.AddHostedService<IngestionWorker>();
        }
        // These loops use V2 repositories / the selected identity ports, never a legacy fallback.
        services.AddSingleton<V2IngestionService>();
        services.AddHostedService<V2IngestionWorker>();
        if (!mode.IsV2)
        {
            services.AddHostedService<MetadataEnrichmentWorker>();
            services.AddHostedService<StuckJobsMetricsWorker>();
            services.AddHostedService<GuestCleanupWorker>();
        }
        services.AddHostedService<RetentionCleanupWorker>();
        services.AddHostedService<HeartbeatWorker>();
        if (!mode.IsV2 && config.GetValue<bool>("TextStack:EnableWatcher")) services.AddHostedService<TextStackWatcher>();
        return services;
    }
}
