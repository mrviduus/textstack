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
    // Production exports no OTLP metrics, so Sentry (Error level = event) is the only way anyone hears of a stuck job.
    private static readonly TimeSpan RepeatAlertAfter = TimeSpan.FromMinutes(15);
    private readonly Dictionary<string, (int Count, DateTimeOffset At)> _lastAlert = [];

    /// <summary>Alert when a queue has stuck jobs and the count changed, or the last alert for it is old enough.</summary>
    public static bool ShouldAlert(int count, (int Count, DateTimeOffset At)? last, DateTimeOffset now) =>
        count > 0 && (last is null || last.Value.Count != count || now - last.Value.At >= RepeatAlertAfter);

    private void Report(string queue, int count, TimeSpan window, DateTimeOffset now)
    {
        IngestionMetrics.SetStuckJobs(queue, count);
        var seen = _lastAlert.TryGetValue(queue, out var last);
        if (ShouldAlert(count, seen ? last : null, now))
        {
            logger.LogError("{Count} {Queue} job(s) still running after {Window} — worker likely died mid-job",
                count, queue, window);
            _lastAlert[queue] = (count, now);
        }
        else if (count == 0)
        {
            _lastAlert.Remove(queue);
        }
    }
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
        Report("seo_backfill", await db.SeoBackfillJobs
            .CountAsync(j => j.Status == SeoJobStatus.Running && j.StartedAt < seo, ct), SeoJobProcessor.StaleAfter, now);

        var ingestion = now - IngestionService.StuckJobTimeout;
        Report("ingestion", await db.IngestionJobs
            .CountAsync(j => j.Status == JobStatus.Processing && j.StartedAt < ingestion, ct), IngestionService.StuckJobTimeout, now);

        var userIngestion = now - UserIngestionService.StuckJobTimeout;
        Report("user_ingestion", await db.UserIngestionJobs
            .CountAsync(j => j.Status == JobStatus.Processing && j.StartedAt < userIngestion, ct), UserIngestionService.StuckJobTimeout, now);

        var ssg = now - SsgStaleAfter;
        Report("ssg_rebuild", await db.SsgRebuildJobs
            .CountAsync(j => j.Status == SsgRebuildJobStatus.Running && j.StartedAt < ssg, ct), SsgStaleAfter, now);

        var enrichment = now - MetadataEnrichmentWorker.StaleAfter;
        Report("metadata_enrichment", await db.UserBooks
            .CountAsync(b => b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Running
                             && b.MetadataEnrichmentAt < enrichment, ct), MetadataEnrichmentWorker.StaleAfter, now);
    }
}
