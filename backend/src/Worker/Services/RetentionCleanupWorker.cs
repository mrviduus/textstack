using Application.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Infrastructure.Persistence.Repositories;

namespace Worker.Services;

/// <summary>
/// The "how long do we keep this row" rules, in one daily sweep. Each rule is its own try, so a
/// failure on one table never skips the others. The credential rules are the identity ports' sweeps
/// (#1100); the AI text rules are the V2 trace writers'.
/// Not here: <c>oauth_authorization_requests</c>, swept on every authorize (<c>OAuthEndpoints</c>).
/// </summary>
public class RetentionCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<RetentionCleanupWorker> logger,
    TimeProvider? clock = null) : BackgroundService
{
    // Daily: expired rows are harmless (every reader filters on expiry) but accumulate forever.
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    /// <summary>A day past expiry before a token row goes, so an in-flight request never races it.</summary>
    public static readonly TimeSpan TokenGrace = TimeSpan.FromDays(1);

    /// <summary>LLM traces and agent runs hold prompt and output text; the admin
    /// AI-quality page defaults to the last 30 days and spend tracking reads only today (#941).</summary>
    public static readonly TimeSpan AiTextRetention = TimeSpan.FromDays(30);

    private const int ScrubBatch = 500;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Retention cleanup worker started (interval: {Interval})", Interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CleanupAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error during retention cleanup");
            }

            await Task.Delay(Interval, clock ?? TimeProvider.System, stoppingToken);
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
