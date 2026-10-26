using System.Linq.Expressions;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// The "how long do we keep this row" rules, in one daily sweep. Each rule is its own try, so a
/// failure on one table never skips the others. Rules are public expressions so tests can run them.
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

    /// <summary>LLM traces, shadow runs and agent runs hold prompt and output text; the admin
    /// AI-quality page defaults to the last 30 days and spend tracking reads only today (#941).</summary>
    public static readonly TimeSpan AiTextRetention = TimeSpan.FromDays(30);

    /// <summary>What a scrubbed trace's required <c>messages_json</c> holds.</summary>
    public const string ScrubbedMessages = "[]";

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
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();

        var now = DateTimeOffset.UtcNow;
        await DeleteAsync("admin refresh tokens",
            () => db.AdminRefreshTokens.Where(t => t.ExpiresAt < now).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("user refresh tokens",
            () => db.UserRefreshTokens.Where(ExpiredUserToken(now)).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("password reset tokens",
            () => db.PasswordResetTokens.Where(ExpiredPasswordReset(now)).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("device authorizations",
            () => db.DeviceAuthorizations.Where(ExpiredDeviceAuthorization(now)).ExecuteDeleteAsync(ct), ct);
        await DeleteAsync("OAuth grants",
            () => db.OAuthGrants.Where(DeadOAuthGrant(now)).ExecuteDeleteAsync(ct), ct);
        // Traces keep their cost, tokens and latency for spend history; only the text goes.
        await DeleteAsync("LLM trace texts (scrubbed)",
            () => db.LlmTraces.Where(LlmTraceTextToScrub(now)).ExecuteUpdateAsync(s => s
                .SetProperty(t => t.SystemPrompt, (string?)null)
                .SetProperty(t => t.MessagesJson, ScrubbedMessages)
                .SetProperty(t => t.ResponseText, (string?)null)
                .SetProperty(t => t.ToolCallsJson, (string?)null), ct), ct);
        await DeleteAsync("shadow runs",
            () => db.ShadowRuns.Where(OldShadowRun(now)).ExecuteDeleteAsync(ct), ct);
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

    /// <summary>
    /// A user refresh token past its expiry, plus a day's grace. Nothing reads it any more: refresh
    /// filters on <c>ExpiresAt</c>, and reuse detection looks a successor up by
    /// <c>PreviousTokenHash</c> — an expired successor is a dead chain, so there is nothing to revoke.
    /// </summary>
    public static Expression<Func<UserRefreshToken, bool>> ExpiredUserToken(DateTimeOffset now)
    {
        var cutoff = now - TokenGrace;
        return t => t.ExpiresAt < cutoff;
    }

    public static Expression<Func<PasswordResetToken, bool>> ExpiredPasswordReset(DateTimeOffset now)
    {
        var cutoff = now - TokenGrace;
        return t => t.ExpiresAt < cutoff;
    }

    public static Expression<Func<DeviceAuthorization, bool>> ExpiredDeviceAuthorization(DateTimeOffset now)
    {
        var cutoff = now - TokenGrace;
        return d => d.ExpiresAt < cutoff;
    }

    /// <summary>
    /// A grant that can never authorize again: revoked, or its refresh token expired. Reuse
    /// detection reads only live grants (<c>RevokedAt == null</c>, by <c>PreviousRefreshTokenHash</c>),
    /// so a dead row is not needed for it.
    /// </summary>
    public static Expression<Func<OAuthGrant, bool>> DeadOAuthGrant(DateTimeOffset now)
    {
        var cutoff = now - TokenGrace;
        return g => g.RevokedAt < cutoff || g.RefreshTokenExpiresAt < cutoff;
    }

    /// <summary>A trace older than the retention that still holds text (not yet scrubbed).</summary>
    public static Expression<Func<LlmTrace, bool>> LlmTraceTextToScrub(DateTimeOffset now)
    {
        var cutoff = now - AiTextRetention;
        return t => t.CreatedAt < cutoff
            && (t.MessagesJson != ScrubbedMessages || t.SystemPrompt != null
                || t.ResponseText != null || t.ToolCallsJson != null);
    }

    public static Expression<Func<ShadowRun, bool>> OldShadowRun(DateTimeOffset now)
    {
        var cutoff = now - AiTextRetention;
        return r => r.CreatedAt < cutoff;
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
