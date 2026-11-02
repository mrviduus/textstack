using Application.Common.Interfaces;
using Application.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Reaps legacy guests idle for <see cref="ExpiryThreshold"/> that hold nothing, and with
/// <c>Features:V2Api</c> on, each one's V2 account and bytes after its legacy delete commits.
/// </summary>
/// <remarks>
/// ponytail: no V2-side guest sweep here. Until M5.1 a V2 <c>users.last_active_at</c> is written only by
/// the identity mirror, so every shadow guest on V2 looks idle and a sweep there would reap live guests'
/// rows. M5.1, which moves the activity stamp to V2, adds it (<c>ix_users_guest_cleanup</c> is there).
/// </remarks>
public class GuestCleanupWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<GuestCleanupWorker> logger) : BackgroundService
{
    /// <summary>How long one guest's V2 delete may take: the reaper never waits on V2 longer.</summary>
    public TimeSpan V2Budget { get; init; } = TimeSpan.FromSeconds(10);

    // Run cleanup every 2h: short enough to reclaim abandoned guest slots quickly,
    // long enough to avoid hammering the DB on a weak server.
    private static readonly TimeSpan Interval = TimeSpan.FromHours(2);
    // 30 days inactivity → delete, BUT only if the guest holds no durable value (vocab,
    // highlights, bookmarks, library). Engaged guests live indefinitely so they don't lose
    // data when they finally come back to register. Pairs with 30d guest refresh-token TTL.
    private static readonly TimeSpan ExpiryThreshold = TimeSpan.FromDays(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Guest cleanup worker started (interval: {Interval}, expiry: {Expiry})",
            Interval, ExpiryThreshold);

        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(Interval, stoppingToken);

            try
            {
                await CleanupExpiredGuestsAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error during guest cleanup");
            }
        }
    }

    private async Task CleanupExpiredGuestsAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IFileStorageService>();

        var cutoff = DateTimeOffset.UtcNow - ExpiryThreshold;

        // Skip guests holding any data the user might want preserved on conversion.
        // Empty/abandoned guests get pruned; engaged guests stay forever (or until they convert).
        // Note: ReadingSessions are deliberately EXCLUDED from the filter — they accumulate on
        // every page read and would keep every bounced visitor alive forever. We only care about
        // signals of intent to save/convert: explicit saves (vocab/highlights/bookmarks), owned
        // library/books/uploads, and progress beyond page 1.
        var expiredGuests = await db.Users
            .Where(u => u.IsGuest
                && u.LastActiveAt < cutoff
                && !db.VocabularyWords.Any(v => v.UserId == u.Id)
                && !db.Highlights.Any(h => h.UserId == u.Id)
                && !db.Bookmarks.Any(b => b.UserId == u.Id)
                && !db.UserLibraries.Any(l => l.UserId == u.Id)
                && !db.UserBooks.Any(b => b.UserId == u.Id)
                && !db.ReadingProgresses.Any(p => p.UserId == u.Id))
            .Include(u => u.UserBooks)
                .ThenInclude(b => b.BookFiles)
            .ToListAsync(ct);

        if (expiredGuests.Count == 0) return;

        logger.LogInformation("Cleaning up {Count} expired guest users", expiredGuests.Count);

        foreach (var guest in expiredGuests)
        {
            try
            {
                // Delete files from storage for each book. Per-book try/catch so a single
                // bad directory (permission / race / lock) doesn't abort the whole guest
                // cleanup — worst case: orphan files remain, but user row still gets removed
                // and the DeleteUserDirectoryAsync sweep below tries to clear the parent.
                foreach (var book in guest.UserBooks)
                {
                    try
                    {
                        await storage.DeleteUserBookDirectoryAsync(guest.Id, book.Id, ct);
                    }
                    catch (Exception ex)
                    {
                        logger.LogWarning(ex, "Failed to delete book dir {BookId} for guest {GuestId}; continuing", book.Id, guest.Id);
                    }
                }

                // Sweep user's parent storage dir — covers cases:
                //   (a) guest without books (UserBooks loop empty, parent dir lingers);
                //   (b) per-book delete partially failed but guest row is being removed anyway;
                //   (c) hygiene: prunes empty shard prefix.
                await storage.DeleteUserDirectoryAsync(guest.Id, ct);

                // Delete user (cascade handles UserBooks, chapters, tokens, etc.)
                db.Users.Remove(guest);
                await db.SaveChangesAsync(ct);

                logger.LogInformation("Deleted expired guest {GuestId}", guest.Id);
                await DeleteOnV2Async(scope.ServiceProvider, guest.Id);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to delete guest {GuestId}", guest.Id);
            }
        }
    }

    /// <summary>
    /// The guest's V2 account, rows and bytes (<see cref="V2AccountDeletion"/>), after its legacy delete
    /// committed: the identity mirror's account delete, for the reaper. Best-effort on its own
    /// <see cref="V2Budget"/>; a failure is an Error log with the id, never thrown, and the M3 ETL
    /// pre-flight sweeps V2 users with no legacy row (#1094).
    /// </summary>
    public async Task DeleteOnV2Async(IServiceProvider services, Guid guestId)
    {
        if (!config.GetValue<bool>("Features:V2Api") || string.IsNullOrWhiteSpace(config.GetConnectionString("V2"))) return;
        using var budget = new CancellationTokenSource(V2Budget);
        try
        {
            await services.GetRequiredService<V2AccountDeletion>().DeleteAsync(guestId, budget.Token);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "V2 delete of expired guest {GuestId} failed; legacy is done, V2 keeps its rows until the ETL sweep (#1094)", guestId);
        }
    }
}
