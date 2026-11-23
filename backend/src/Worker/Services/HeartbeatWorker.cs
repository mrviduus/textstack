using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

// Docker healthcheck reads file mtime. Interval + grace must exceed the worker's
// longest normal pause (30s heartbeat + 2min grace: only hangs/OOM will miss the window).
public class HeartbeatWorker(ILogger<HeartbeatWorker> logger) : BackgroundService
{
    private const string HeartbeatPath = "/tmp/worker-alive";
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Heartbeat worker started (file: {Path}, interval: {Interval})",
            HeartbeatPath, Interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await File.WriteAllTextAsync(HeartbeatPath,
                    DateTimeOffset.UtcNow.ToString("O"), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to write heartbeat");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }
}
