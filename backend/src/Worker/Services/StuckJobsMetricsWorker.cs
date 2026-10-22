using Application.Ingestion;
using Application.Seo;
using Domain.Enums;
using Infrastructure.Persistence;
using Infrastructure.Telemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Publishes <c>queue_stuck_jobs{queue}</c>: rows still Running/Processing past that queue's own stale window.
/// Each queue recovers (or, for ssg, only fails on restart) on its own schedule; this shows when that recovery
/// is not happening. Windows come from the owning code so they cannot drift. Not proof of a dead consumer:
/// ingestion has no heartbeat, so a legitimately long job (big OCR PDF) counts too. Alert on "nonzero for 15m".
/// </summary>
public class StuckJobsMetricsWorker(IDbContextFactory<AppDbContext> dbFactory, ILogger<StuckJobsMetricsWorker> logger)
    : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);
    // ponytail: ssgJob.mjs deadline is max(60 min, 2 s/route), so a huge full build can read as stuck; scale by TotalRoutes if it does.
    private static readonly TimeSpan SsgStaleAfter = TimeSpan.FromMinutes(60);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await UpdateAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to update stuck-job metrics");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task UpdateAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var now = DateTimeOffset.UtcNow;

        var seo = now - SeoJobProcessor.StaleAfter;
        IngestionMetrics.SetStuckJobs("seo_backfill", await db.SeoBackfillJobs
            .CountAsync(j => j.Status == SeoJobStatus.Running && j.StartedAt < seo, ct));

        var ingestion = now - IngestionService.StuckJobTimeout;
        IngestionMetrics.SetStuckJobs("ingestion", await db.IngestionJobs
            .CountAsync(j => j.Status == JobStatus.Processing && j.StartedAt < ingestion, ct));

        var userIngestion = now - UserIngestionService.StuckJobTimeout;
        IngestionMetrics.SetStuckJobs("user_ingestion", await db.UserIngestionJobs
            .CountAsync(j => j.Status == JobStatus.Processing && j.StartedAt < userIngestion, ct));

        var ssg = now - SsgStaleAfter;
        IngestionMetrics.SetStuckJobs("ssg_rebuild", await db.SsgRebuildJobs
            .CountAsync(j => j.Status == SsgRebuildJobStatus.Running && j.StartedAt < ssg, ct));

        var enrichment = now - MetadataEnrichmentWorker.StaleAfter;
        IngestionMetrics.SetStuckJobs("metadata_enrichment", await db.UserBooks
            .CountAsync(b => b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Running
                             && b.MetadataEnrichmentAt < enrichment, ct));
    }
}
