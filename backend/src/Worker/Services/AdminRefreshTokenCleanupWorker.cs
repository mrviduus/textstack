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
        var deleted = await db.AdminRefreshTokens
            .Where(t => t.ExpiresAt < now)
            .ExecuteDeleteAsync(ct);

        if (deleted > 0)
            logger.LogInformation("Deleted {Count} expired admin refresh tokens", deleted);

        var deletedUser = await db.UserRefreshTokens
            .Where(ExpiredUserToken(now))
            .ExecuteDeleteAsync(ct);

        if (deletedUser > 0)
            logger.LogInformation("Deleted {Count} expired user refresh tokens", deletedUser);
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
