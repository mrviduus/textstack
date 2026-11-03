using Application.Common.Interfaces;
using Application.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Reaps legacy guests idle for <see cref="ExpiryThreshold"/> that hold nothing. With
/// <c>Features:V2Api</c> on and <c>ConnectionStrings:V2</c> set, "nothing" includes V2: a guest holding
/// anything there is kept, each reaped one's V2 account and bytes go after its legacy delete commits
/// (<see cref="V2Follow"/>), and a V2 that cannot answer pauses reaping for the run. Without either, V2
/// is not asked (unconfigured, it holds nothing) and V2 holdings of a reaped guest are orphans the M3 ETL
/// pre-flight sweeps (#1094).
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
    /// <summary>How long one V2 step for one guest may take: the reaper never waits on V2 longer.</summary>
    public TimeSpan V2Budget { get; init; } = V2Follow.Budget;

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

    public async Task CleanupExpiredGuestsAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IFileStorageService>();
        var v2 = scope.ServiceProvider.GetRequiredService<V2AccountDeletion>();

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

        var askV2 = V2Follow.IsOn(config) && !string.IsNullOrWhiteSpace(config.GetConnectionString("V2"));
        foreach (var guest in expiredGuests)
        {
            // Legacy's filter cannot see V2: a guest that uploaded or annotated there is engaged too.
            // V2 unable to answer reaps nobody this run rather than guessing.
            if (askV2)
            {
                var holdsNothing = false;
                if (!await V2Follow.RunAsync(config, logger, "expired guest check", guest.Id, guest.Id,
                        "guest reaping paused for this run: V2 is configured but did not say what expired guests hold there",
                        async t => holdsNothing = await v2.HoldsNothingDurableAsync(guest.Id, t), V2Budget))
                    return;
                if (!holdsNothing) continue;
            }

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
                if (askV2)
                    await V2Follow.RunAsync(config, logger, "expired guest delete", guest.Id, guest.Id, V2Follow.RowsLeftForTheEtlSweep,
                        t => v2.DeleteAsync(guest.Id, t), V2Budget);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to delete guest {GuestId}", guest.Id);
            }
        }
    }
}
