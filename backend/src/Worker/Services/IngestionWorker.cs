using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Transitional (dropped at M6.4, ADR-031): the one consumer of the V2 <c>ingestion_jobs</c> queue
/// (ADR-022), <see cref="IngestionService"/>. The byte sweeps are <see cref="RetentionCleanupWorker"/>'s.
/// A V2 outage pauses it with a Warning and a back-off; nothing legacy waits on it.
/// </summary>
public sealed class IngestionWorker(IServiceProvider services, ILogger<IngestionWorker> logger) : BackgroundService
{
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan Backoff { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan StuckReportEvery { get; init; } = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var ingestion = services.GetRequiredService<IngestionService>();
        var clock = services.GetService<TimeProvider>() ?? TimeProvider.System;
        var lastStuckReport = DateTimeOffset.MinValue;
        var delay = TimeSpan.Zero;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(delay, stoppingToken);
                // On its own clock, before each job: a steady queue must not starve it. Stamped first, so a
                // failing count waits its interval instead of running on every pass.
                var now = clock.GetUtcNow();
                if (now - lastStuckReport >= StuckReportEvery)
                {
                    lastStuckReport = now;
                    await ingestion.ReportStuckAsync(stoppingToken);
                }
                delay = await ingestion.ProcessNextAsync(stoppingToken) ? TimeSpan.Zero : PollInterval;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                logger.LogWarning(e, "V2 ingestion paused: textstack_v2 failed; retrying in {Backoff}", Backoff);
                delay = Backoff;
            }
        }
    }
}
