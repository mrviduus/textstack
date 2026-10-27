using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class GuestCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<GuestCleanupWorker> logger) : BackgroundService
{
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
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to delete guest {GuestId}", guest.Id);
            }
        }
    }
}
