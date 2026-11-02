using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Transitional (dropped at M6.4, ADR-031): the one consumer of the V2 <c>ingestion_jobs</c> queue
/// (ADR-022) and the V2 byte sweep, <see cref="V2IngestionService"/>. Runs only with
/// <c>Features:V2Api</c> on and <c>ConnectionStrings:V2</c> set, and resolves nothing V2 until then.
/// A V2 outage pauses it with a Warning and a back-off; nothing legacy waits on it.
/// </summary>
public sealed class V2IngestionWorker(IConfiguration config, IServiceProvider services, ILogger<V2IngestionWorker> logger) : BackgroundService
{
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan Backoff { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan SweepEvery { get; init; } = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue<bool>("Features:V2Api") || string.IsNullOrWhiteSpace(config.GetConnectionString("V2")))
        {
            logger.LogInformation("V2 ingestion is off (Features:V2Api or ConnectionStrings:V2 unset)");
            return;
        }
        var ingestion = services.GetRequiredService<V2IngestionService>();
        var lastSweep = DateTimeOffset.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await ingestion.ProcessNextAsync(stoppingToken)) continue;
                if (DateTimeOffset.UtcNow - lastSweep >= SweepEvery)
                {
                    await ingestion.SweepAsync(stoppingToken);
                    lastSweep = DateTimeOffset.UtcNow;
                }
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                logger.LogWarning(e, "V2 ingestion paused: textstack_v2 failed; retrying in {Backoff}", Backoff);
                try
                {
                    await Task.Delay(Backoff, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }
}
