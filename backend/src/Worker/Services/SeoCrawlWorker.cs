using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class SeoCrawlWorker : BackgroundService
{
    private readonly SeoCrawlWorkerService _crawlService;
    private readonly ILogger<SeoCrawlWorker> _logger;
    private readonly TimeSpan _pollInterval = TimeSpan.FromSeconds(5);

    public SeoCrawlWorker(SeoCrawlWorkerService crawlService, ILogger<SeoCrawlWorker> logger)
    {
        _crawlService = crawlService;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("SEO Crawl worker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var job = await _crawlService.GetNextJobAsync(stoppingToken);

                if (job is not null)
                {
                    _logger.LogInformation("Found SEO crawl job {JobId}, processing...", job.Id);
                    await _crawlService.ProcessJobAsync(job.Id, stoppingToken);
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
                _logger.LogError(ex, "Error in SEO crawl worker loop");
                await Task.Delay(_pollInterval, stoppingToken);
            }
        }

        _logger.LogInformation("SEO Crawl worker stopped");
    }
}
