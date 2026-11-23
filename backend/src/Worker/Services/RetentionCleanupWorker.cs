using Application.Common.Interfaces;
using Application.Identity;
using Application.Library;
using Domain.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Infrastructure.Persistence.Repositories;

namespace Worker.Services;

/// <summary>
/// The "how long do we keep this row" rules, in one daily sweep, and the library's byte sweeps: stale
/// upload parts every minute, orphan bytes daily (moved from the ingestion worker, ADR-033 P2). Each rule
/// is its own try, so a failure on one never skips the others. The credential rules are the identity
/// ports' sweeps (#1100); the AI text rules are the V2 trace writers'.
/// Not here: <c>oauth_authorization_requests</c>, swept on every authorize (<c>OAuthEndpoints</c>).
/// </summary>
public class RetentionCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<RetentionCleanupWorker> logger,
    TimeProvider? clock = null) : BackgroundService
{
    // Daily: expired rows are harmless (every reader filters on expiry) but accumulate forever.
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    /// <summary>The stale-parts sweep's cadence; the daily rules run on the first tick a day after the last.</summary>
    public TimeSpan Tick { get; init; } = TimeSpan.FromMinutes(1);

    // A file younger than this may be an attach or a cover between its place and its commit, and a
    // directory that young may be about to receive one: neither is an orphan yet.
    private static readonly TimeSpan OrphanAge = TimeSpan.FromHours(1);

    /// <summary>A day past expiry before a token row goes, so an in-flight request never races it.</summary>
    public static readonly TimeSpan TokenGrace = TimeSpan.FromDays(1);

    /// <summary>LLM traces and agent runs hold prompt and output text; the admin
    /// AI-quality page defaults to the last 30 days and spend tracking reads only today (#941).</summary>
    public static readonly TimeSpan AiTextRetention = TimeSpan.FromDays(30);

    private const int ScrubBatch = 500;

    /// <summary>A guest idle this long that holds nothing durable goes; one that holds anything stays
    /// until it signs up (the deleted legacy GuestCleanupWorker's 30 days, paired with the guest
    /// refresh-token lifetime).</summary>
    public static readonly TimeSpan GuestRetention = TimeSpan.FromDays(30);

    // ponytail: one batch of guests per daily run keeps the transaction small; a backlog larger than
    // this drains over days. Loop like the trace scrub if guest sign-ups ever outrun it.
    private const int GuestBatch = 500;

    /// <summary>A guest idle this long goes with everything it holds, books and files included, through
    /// the account delete's path (owner decision 2026-11-23, #1417).</summary>
    public static readonly TimeSpan GuestWithDataRetention = TimeSpan.FromDays(90);

    /// <summary>The privacy policy announced the rule on this day; before it, a guest with data was kept. The
    /// 90 days count from here (owner 2026-11-23), so the first such guest goes around 2027-02-21.</summary>
    public static readonly DateTimeOffset GuestWithDataSince = new(2026, 11, 24, 0, 0, 0, TimeSpan.Zero);

    // ponytail: one batch per daily run, each guest its own delete and file cleanup; a backlog (174 on
    // prod at the switch) drains over days. A guest skipped as locked or active would be listed again
    // at once, so no loop within a run.
    private const int GuestWithDataBatch = 100;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Retention cleanup worker started (interval: {Interval}, parts sweep: {Tick})", Interval, Tick);

        var lastDaily = DateTimeOffset.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await DeleteAsync("stale upload parts", SweepStaleParts, stoppingToken);
                // Stamped first, so a failing run waits a day instead of running on every tick.
                var now = (clock ?? TimeProvider.System).GetUtcNow();
                if (now - lastDaily >= Interval)
                {
                    lastDaily = now;
                    await CleanupAsync(stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error during retention cleanup");
            }

            await Task.Delay(Tick, clock ?? TimeProvider.System, stoppingToken);
        }
    }

    private async Task CleanupAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;

        var now = (clock ?? TimeProvider.System).GetUtcNow();
        // A day past expiry: nothing reads an expired token (refresh filters on expiry, reuse detection
        // reads live rows only), and an in-flight request never races the sweep.
        var tokenCutoff = now - TokenGrace;
        // Each port is resolved inside its own rule, so a wiring fault fails that rule only.
        await DeleteAsync("sessions",
            () => services.GetRequiredService<ISessionTokenRepository>().DeleteExpiredSessionsAsync(tokenCutoff, ct), ct);
        await DeleteAsync("password reset tokens",
            () => services.GetRequiredService<ISessionTokenRepository>().DeleteExpiredPasswordResetsAsync(tokenCutoff, ct), ct);
        await DeleteAsync("device authorizations",
            () => services.GetRequiredService<IDeviceLoginRepository>().DeleteExpiredAsync(tokenCutoff, ct), ct);
        await DeleteAsync("OAuth grants",
            () => services.GetRequiredService<IOAuthRepository>().DeleteDeadGrantsAsync(tokenCutoff, ct), ct);
        await DeleteAsync("inactive empty guests", async () =>
        {
            var pictures = await services.GetRequiredService<IAccountMergeRepository>().DeleteIdleEmptyGuestsAsync(now - GuestRetention, GuestBatch, ct);
            // An empty guest's only bytes: an uploaded avatar (book bytes need a book row, which keeps the guest).
            var storage = services.GetRequiredService<IFileStorageService>();
            foreach (var picture in pictures.Where(UserAccount.IsStoredPicture))
            {
                try { await storage.DeleteFileAsync(picture!, ct); }
                catch (Exception ex) when (!ct.IsCancellationRequested) { logger.LogWarning(ex, "Retention: could not delete avatar {Path}; it is left as an orphan", picture); }
            }
            return pictures.Count;
        }, ct);
        if (now - GuestWithDataRetention > GuestWithDataSince)
            await DeleteAsync("inactive guests with data",
                () => services.GetRequiredService<AccountDeletion>().DeleteIdleGuestsAsync(now - GuestWithDataRetention, GuestWithDataBatch, ct), ct);
        await DeleteAsync("orphan library files",
            () => SweepOrphansAsync(services.GetRequiredService<ILibraryRepository>(), services.GetRequiredService<ILibraryFileStore>(), ct), ct);
        // Traces keep their cost, tokens and latency for spend history; only the text goes. Batches:
        // one statement over months of text would be one huge transaction (#941).
        var aiCutoff = now - AiTextRetention;
        await DeleteAsync("LLM trace texts (scrubbed)", async () =>
        {
            var traces = services.GetRequiredService<LlmTraceWriter>();
            int batch, total = 0;
            do
            {
                batch = await traces.ScrubTextBatchAsync(aiCutoff, ScrubBatch, ct);
                total += batch;
            } while (batch == ScrubBatch && !ct.IsCancellationRequested);
            return total;
        }, ct);
        await DeleteAsync("agent runs",
            () => services.GetRequiredService<AgentRunWriter>().DeleteOlderThanAsync(aiCutoff, ct), ct);
    }

    /// <summary>
    /// Deletes upload parts untouched for a day: filesystem only. Superseded bytes go at replace time; a
    /// removed book keeps its bytes (removal is a hide, owner decision 11).
    /// </summary>
    private Task<int> SweepStaleParts()
    {
        using var scope = scopeFactory.CreateScope();
        scope.ServiceProvider.GetRequiredService<ILibraryFileStore>().SweepStaleParts((clock ?? TimeProvider.System).GetUtcNow());
        return Task.FromResult(0); // the store does not count what it swept
    }

    /// <summary>
    /// Deletes bytes under <c>library/</c> older than <see cref="OrphanAge"/> that no file or cover names,
    /// then empty directories. One mechanism for every way bytes lose their row: a commit that failed
    /// after the place, a merge's dropped guest copies, a crashed join's temp file, a key cleared whose
    /// delete failed. The keys are read first: a file written after that is younger than the cutoff.
    /// </summary>
    private async Task<int> SweepOrphansAsync(ILibraryRepository library, ILibraryFileStore files, CancellationToken ct)
    {
        var referenced = await library.AllStorageKeysAsync(ct);
        var cutoff = (clock ?? TimeProvider.System).GetUtcNow() - OrphanAge;
        var deleted = 0;
        foreach (var key in files.EnumerateLibraryFilesOlderThan(cutoff))
        {
            if (referenced.Contains(key)) continue;
            if (files.TryDelete(key)) deleted++;
            else logger.LogWarning("Could not delete orphan V2 bytes at {StorageKey}; retried next sweep", key);
        }
        files.RemoveEmptyDirectories(cutoff);
        return deleted;
    }

    private async Task DeleteAsync(string what, Func<Task<int>> delete, CancellationToken ct)
    {
        try
        {
            var deleted = await delete();
            if (deleted > 0)
                logger.LogInformation("Retention: deleted {Count} {What}", deleted, what);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogError(ex, "Retention: error deleting {What}", what);
        }
    }
}
