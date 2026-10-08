using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Llm;

namespace Worker.Services;

/// <summary>
/// Sweep that (a) drains <see cref="MetadataEnrichmentStatus.Pending"/> user books — this is how the API's
/// re-enrich request reaches the worker, since the API host has no enrichment executor — and (b) recovers
/// dead-process rows stuck in <see cref="MetadataEnrichmentStatus.Running"/> past the stale window back to
/// Pending. It is the only consumer (ADR-022): a fresh ingestion leaves the book Pending and the next
/// tick takes it.
/// </summary>
public class MetadataEnrichmentWorker(
    IDbContextFactory<AppDbContext> dbFactory,
    UserBookEnrichmentService enrichmentService,
    IConfiguration config,
    IProviderHealth health,
    ILogger<MetadataEnrichmentWorker> logger) : BackgroundService
{
    /// <summary>The agent path; falls back to <see cref="FallbackFeatureTag"/> on any agent error.</summary>
    public const string PrimaryFeatureTag = "bookmeta.agent";
    public const string FallbackFeatureTag = "bookmeta";

    /// <summary>
    /// Drain only while at least one provider on the enrichment path can answer. Pure so the
    /// invariant is testable without a clock, a container or a database.
    /// </summary>
    public static bool ShouldDrainPending(bool primaryAvailable, bool fallbackAvailable) =>
        primaryAvailable || fallbackAvailable;

    private string PrimaryProvider => AiRouteMap.ResolveProviderKey(config, PrimaryFeatureTag);
    private string FallbackProvider => AiRouteMap.ResolveProviderKey(config, FallbackFeatureTag);

    private bool IsAvailable(string providerKey) =>
        health.IsAvailable(providerKey, DateTimeOffset.UtcNow);

    /// <summary>Tracks the skip→resume edge so a 30 s loop logs transitions, not every cycle.</summary>
    private bool _skippingDrain;

    // Short interval: re-enrich requests should feel near-immediate, and the work is cheap (a bounded
    // claim query + fire best-effort). Mirrors GuestCleanupWorker's delay-loop shape.
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    // A Running row untouched for this long means the process that claimed it died mid-run → reclaim.
    private static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(10);
    private const int BatchSize = 20;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "Metadata enrichment worker started (interval: {Interval}, stale: {Stale})", Interval, StaleAfter);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error during metadata enrichment sweep");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);

        // (b) Dead-process recovery: reclaim stale Running rows so they get another attempt.
        var staleCutoff = DateTimeOffset.UtcNow - StaleAfter;
        var reclaimed = await db.UserBooks
            .Where(b => b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Running
                        && b.MetadataEnrichmentAt < staleCutoff)
            .ExecuteUpdateAsync(s => s
                .SetProperty(b => b.MetadataEnrichmentStatus, MetadataEnrichmentStatus.Pending), ct);

        if (reclaimed > 0)
            logger.LogWarning("Reclaimed {Count} stale Running enrichment row(s) to Pending", reclaimed);

        // (a) Drain Pending — but ONLY while some provider on the enrichment path can answer.
        //
        // This gate is not an optimisation, it prevents data loss: UserBookEnrichmentService stamps
        // Completed (not Failed) when the generator returns null, which is exactly what an
        // unreachable provider produces. Claiming rows during an outage therefore drains the queue
        // to a terminal "done, nothing filled" state that nothing ever revisits. Leaving them
        // Pending costs one skipped cycle and loses nothing.
        //
        // The stale-Running reclaim above stays unconditional: it is pure DB work, and a process
        // that died mid-outage must still recover.
        if (!ShouldDrainPending(IsAvailable(PrimaryProvider), IsAvailable(FallbackProvider)))
        {
            if (!_skippingDrain)
            {
                _skippingDrain = true;
                logger.LogInformation(
                    "Metadata enrichment: pausing Pending drain — neither '{Primary}' nor '{Fallback}' "
                    + "is available; rows stay Pending", PrimaryProvider, FallbackProvider);
            }
            else
            {
                logger.LogDebug("Metadata enrichment: still paused; Pending rows untouched");
            }

            return;
        }

        if (_skippingDrain)
        {
            _skippingDrain = false;
            logger.LogInformation("Metadata enrichment: provider available again — resuming Pending drain");
        }

        var pendingIds = await db.UserBooks
            .Where(b => b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Pending)
            .OrderBy(b => b.CreatedAt)
            .Select(b => b.Id)
            .Take(BatchSize)
            .ToListAsync(ct);

        foreach (var id in pendingIds)
        {
            ct.ThrowIfCancellationRequested();
            await enrichmentService.EnrichAsync(id, ct);
        }
    }
}
