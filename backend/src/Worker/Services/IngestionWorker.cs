using Infrastructure.Telemetry;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class IngestionWorker : BackgroundService
{
    private readonly IngestionWorkerService _ingestionService;
    private readonly UserIngestionService _userIngestionService;
    private readonly ILogger<IngestionWorker> _logger;
    private readonly TimeSpan _pollInterval = TimeSpan.FromSeconds(5);
    private readonly TimeSpan _metricsInterval = TimeSpan.FromSeconds(10);

    public IngestionWorker(
        IngestionWorkerService ingestionService,
        UserIngestionService userIngestionService,
        ILogger<IngestionWorker> logger)
    {
        _ingestionService = ingestionService;
        _userIngestionService = userIngestionService;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Ingestion worker started");

        // Start background task for queue metrics
        _ = UpdateQueueMetricsAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Check public jobs first (priority)
                var job = await _ingestionService.GetNextJobAsync(stoppingToken);
                if (job is not null)
                {
                    IngestionMetrics.SetJobsInProgress(1);
                    _logger.LogInformation("Found public job {JobId}, processing...", job.Id);
                    await _ingestionService.ProcessJobAsync(job.Id, stoppingToken);
                    IngestionMetrics.SetJobsInProgress(0);
                    continue;
                }

                // Check user book jobs
                var userJob = await _userIngestionService.GetNextJobAsync(stoppingToken);
                if (userJob is not null)
                {
                    _logger.LogInformation("Found user job {JobId}, processing...", userJob.Id);
                    await _userIngestionService.ProcessJobAsync(userJob.Id, stoppingToken);
                    continue;
                }

                // No jobs, wait
                await Task.Delay(_pollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                IngestionMetrics.SetJobsInProgress(0);
                _logger.LogError(ex, "Error in ingestion worker loop");
                await Task.Delay(_pollInterval, stoppingToken);
            }
        }

        _logger.LogInformation("Ingestion worker stopped");
    }

    private async Task UpdateQueueMetricsAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var (pendingCount, oldestJobAge) = await _ingestionService.GetQueueStatsAsync(ct);
                IngestionMetrics.SetJobsPending(pendingCount);
                IngestionMetrics.SetOldestPendingJobAge(oldestJobAge);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to update queue metrics");
            }

            await Task.Delay(_metricsInterval, ct);
        }
    }
}
