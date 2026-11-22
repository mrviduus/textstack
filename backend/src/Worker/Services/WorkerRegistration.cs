using Infrastructure.Persistence;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public static class WorkerRegistration
{
    public static IServiceCollection AddWorkerLoops(this IServiceCollection services, IConfiguration config)
    {
        // First: queue consumers never start before the single-consumer lock is held on the database.
        var connection = config.AppConnectionString()
            ?? throw new InvalidOperationException("ConnectionStrings:Default is required");
        services.AddHostedService(sp => new SingleInstanceLock(connection, sp.GetRequiredService<ILogger<SingleInstanceLock>>()));
        services.AddHostedService<AiProviderReadinessCheck>();
        services.AddSingleton<IngestionService>();
        services.AddHostedService<IngestionWorker>();
        services.AddHostedService<RetentionCleanupWorker>();
        services.AddHostedService<HeartbeatWorker>();
        return services;
    }
}
