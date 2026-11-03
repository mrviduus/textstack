using System.Linq.Expressions;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// The "how long do we keep this row" rules, in one daily sweep. Each rule is its own try, so a
/// failure on one table never skips the others. The credential rules are the identity ports' sweeps
/// (#1100); the rest are public expressions so tests can run them.
/// Not here: <c>oauth_authorization_requests</c>, swept on every authorize (<c>OAuthEndpoints</c>).
/// </summary>
public class RetentionCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<RetentionCleanupWorker> logger) : BackgroundService
{
    // Daily: expired rows are harmless (every reader filters on expiry) but accumulate forever.
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    /// <summary>A day past expiry before a token row goes, so an in-flight request never races it.</summary>
    public static readonly TimeSpan TokenGrace = TimeSpan.FromDays(1);

    /// <summary>LLM traces and agent runs hold prompt and output text; the admin
    /// AI-quality page defaults to the last 30 days and spend tracking reads only today (#941).</summary>
    public static readonly TimeSpan AiTextRetention = TimeSpan.FromDays(30);

    /// <summary>What a scrubbed trace's required <c>messages_json</c> holds.</summary>
    public const string ScrubbedMessages = "[]";

    private const int ScrubBatch = 500;

    /// <summary>Tutor sessions idle this long are over, finished or abandoned (#944).</summary>
    public static readonly TimeSpan TutorSessionRetention = TimeSpan.FromDays(90);

    /// <summary>Finished prerender jobs: the admin history page needs recent ones only (#949).</summary>
    public static readonly TimeSpan SsgJobRetention = TimeSpan.FromDays(30);

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

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task CleanupAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<IAppDbContext>();

        var now = DateTimeOffset.UtcNow;
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
        // Traces keep their cost, tokens and latency for spend history; only the text goes.
        // Batches: the first run rewrites months of text (~750 MB); one statement would be one huge
        // transaction.
        await DeleteAsync("LLM trace texts (scrubbed)", async () =>
        {
            int batch, total = 0;
            do
            {
                batch = await db.LlmTraces.Where(LlmTraceTextToScrub(now)).OrderBy(t => t.Id).Take(ScrubBatch)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(t => t.SystemPrompt, (string?)null)
                        .SetProperty(t => t.MessagesJson, ScrubbedMessages)
                        .SetProperty(t => t.ResponseText, (string?)null)
                        .SetProperty(t => t.ToolCallsJson, (string?)null), ct);
                total += batch;
            } while (batch == ScrubBatch && !ct.IsCancellationRequested);
            return total;
        }, ct);
        await DeleteAsync("agent runs",
            () => db.AgentRuns.Where(OldAgentRun(now)).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("tutor sessions",
            () => db.TutorSessions.Where(OldTutorSession(now)).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("SSG rebuild jobs", async () =>
        {
            // /health/ready measures SSG staleness from the newest Completed job: never sweep it.
            var newestCompleted = await db.SsgRebuildJobs
                .Where(j => j.Status == SsgRebuildJobStatus.Completed && j.FinishedAt != null)
                .OrderByDescending(j => j.FinishedAt)
                .Select(j => (Guid?)j.Id)
                .FirstOrDefaultAsync(ct);
            return await db.SsgRebuildJobs.Where(OldSsgRebuildJob(now))
                .Where(j => j.Id != newestCompleted)
                .ExecuteDeleteAsync(ct);
        }, ct);
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

    /// <summary>A trace older than the retention that still holds text (not yet scrubbed).</summary>
    public static Expression<Func<LlmTrace, bool>> LlmTraceTextToScrub(DateTimeOffset now)
    {
        var cutoff = now - AiTextRetention;
        return t => t.CreatedAt < cutoff
            && (t.MessagesJson != ScrubbedMessages || t.SystemPrompt != null
                || t.ResponseText != null || t.ToolCallsJson != null);
    }

    public static Expression<Func<AgentRun, bool>> OldAgentRun(DateTimeOffset now)
    {
        var cutoff = now - AiTextRetention;
        return r => r.CreatedAt < cutoff;
    }

    public static Expression<Func<TutorSession, bool>> OldTutorSession(DateTimeOffset now)
    {
        var cutoff = now - TutorSessionRetention;
        return s => s.UpdatedAt < cutoff;
    }

    /// <summary>Finished only: a queued or running job is never swept, however old.</summary>
    public static Expression<Func<SsgRebuildJob, bool>> OldSsgRebuildJob(DateTimeOffset now)
    {
        var cutoff = now - SsgJobRetention;
        return j => j.FinishedAt < cutoff;
    }
}
