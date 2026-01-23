using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class SsgRebuildWorker : BackgroundService
{
    private readonly SsgRebuildWorkerService _service;
    private readonly ILogger<SsgRebuildWorker> _logger;
    private readonly TimeSpan _pollInterval = TimeSpan.FromSeconds(5);

    public SsgRebuildWorker(SsgRebuildWorkerService service, ILogger<SsgRebuildWorker> logger)
    {
        _service = service;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("SSG Rebuild worker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var job = await _service.GetNextJobAsync(stoppingToken);

                if (job is not null)
                {
                    _logger.LogInformation("Found SSG rebuild job {JobId}, processing...", job.Id);
                    await _service.ProcessJobAsync(job.Id, stoppingToken);
                }
                else
                {
                    await Task.Delay(_pollInterval, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in SSG rebuild worker loop");
                await Task.Delay(_pollInterval, stoppingToken);
            }
        }

        _logger.LogInformation("SSG Rebuild worker stopped");
    }
}
