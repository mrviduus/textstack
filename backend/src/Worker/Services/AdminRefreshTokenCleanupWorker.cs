using System.Linq.Expressions;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class AdminRefreshTokenCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<AdminRefreshTokenCleanupWorker> logger) : BackgroundService
{
    // Run daily — expired rows are harmless (rejected by the refresh ExpiresAt filters) but
    // accumulate forever: admin and user refresh tokens alike. Hourly is overkill.
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Admin refresh token cleanup worker started (interval: {Interval})", Interval);

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
                logger.LogError(ex, "Error during admin refresh token cleanup");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task CleanupAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();

        var now = DateTimeOffset.UtcNow;
        // Separate tries: a failure on one table must not skip the other's cleanup.
        await DeleteExpiredAsync("admin",
            () => db.AdminRefreshTokens.Where(t => t.ExpiresAt < now).ExecuteDeleteAsync(ct), ct);
        await DeleteExpiredAsync("user",
            () => db.UserRefreshTokens.Where(ExpiredUserToken(now)).ExecuteDeleteAsync(ct), ct);
    }

    private async Task DeleteExpiredAsync(string kind, Func<Task<int>> delete, CancellationToken ct)
    {
        try
        {
            var deleted = await delete();
            if (deleted > 0)
                logger.LogInformation("Deleted {Count} expired {Kind} refresh tokens", deleted, kind);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogError(ex, "Error deleting expired {Kind} refresh tokens", kind);
        }
    }

    /// <summary>
    /// A user refresh token past its expiry, plus a day's grace. Nothing reads it any more: refresh
    /// filters on <c>ExpiresAt</c>, and reuse detection looks a successor up by
    /// <c>PreviousTokenHash</c> — an expired successor is a dead chain, so there is nothing to revoke.
    /// </summary>
    public static Expression<Func<UserRefreshToken, bool>> ExpiredUserToken(DateTimeOffset now)
    {
        var cutoff = now - UserTokenGrace;
        return t => t.ExpiresAt < cutoff;
    }

    public static readonly TimeSpan UserTokenGrace = TimeSpan.FromDays(1);
}
