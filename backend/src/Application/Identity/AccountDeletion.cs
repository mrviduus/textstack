using Application.Common.Interfaces;
using Application.Library;
using Domain.Identity;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// Deletes a V2 account with its bytes: the account delete on V2, the identity mirror following a
/// legacy delete, and the guest reaper (<see cref="DeleteIdleGuestsAsync"/>). One place, so the bytes
/// cannot be forgotten by one of them (QA of M2.6: expired guests' books, covers and parts stayed forever).
/// </summary>
public sealed class AccountDeletion(IUserRepository users, IAccountMergeRepository aggregates, IBookAccess library, ILibraryFileStore files, IFileStorageService storage, ILogger<AccountDeletion> logger)
{
    /// <summary>Best-effort cleanup after a committed merge; the orphan sweep retries leftovers.</summary>
    public void DeleteReleasedFiles(IReadOnlyList<string> keys)
    {
        foreach (var key in keys)
            if (!files.TryDelete(key)) logger.LogWarning("Could not delete released {StorageKey}; the orphan sweep will", key);
    }

    /// <summary>
    /// Whether the account holds nothing a reader would miss on V2: no book, annotation, word, reading
    /// state, share, checkpoint or insight. What the guest reaper asks before reaping on legacy, whose
    /// own filter cannot see V2.
    /// </summary>
    public Task<bool> HoldsNothingDurableAsync(Guid userId, CancellationToken ct) => aggregates.HoldsNothingDurableAsync(userId, ct);

    /// <summary>
    /// Safe to fail at any step, so a caller without a readiness check (the Worker) leaves no half
    /// state: the keys are read first, then the rows go in one statement (<c>DELETE FROM users</c>; the
    /// cascade drops the rest), and only once it committed the bytes: the account's own directories,
    /// then any key it held elsewhere (after a merge some sit under the former guest's directory; the
    /// rest are already gone, a cheap no-op), then its files in the public <c>/storage</c> root (uploads'
    /// tree, a local avatar). A failure before the delete touches nothing; a byte left behind the orphan
    /// sweep collects. False when there was no such account (its directories are still swept).
    /// </summary>
    public Task<bool> DeleteAsync(Guid userId, CancellationToken ct) =>
        DeleteAsync(userId, () => users.DeleteAsync(userId, ct), sweepWhenGone: true, ct);

    /// <summary>
    /// The reaper of guests that hold data (#1417): up to <paramref name="limit"/> guests idle since
    /// before <paramref name="idleSince"/>, each deleted as <see cref="DeleteAsync(Guid, CancellationToken)"/>
    /// does, in its own statement. A guest locked right now, active again or merged into an account
    /// meanwhile stays, and its files are not touched. Returns how many went.
    /// </summary>
    public async Task<int> DeleteIdleGuestsAsync(DateTimeOffset idleSince, int limit, CancellationToken ct)
    {
        var deleted = 0;
        foreach (var guestId in await aggregates.ListIdleGuestsAsync(idleSince, limit, ct))
            if (await DeleteAsync(guestId, () => aggregates.DeleteGuestIfIdleAsync(guestId, idleSince, ct), sweepWhenGone: false, ct))
                deleted++;
        return deleted;
    }

    private async Task<bool> DeleteAsync(Guid userId, Func<Task<bool>> deleteRows, bool sweepWhenGone, CancellationToken ct)
    {
        var picture = (await users.GetAsync(userId, ct))?.Picture;
        var keys = await library.ListStorageKeysAsync(userId, ct);
        var deleted = await deleteRows();
        if (!deleted && !sweepWhenGone) return false;
        files.DeleteUser(userId);
        foreach (var key in keys)
            if (!files.TryDelete(key)) logger.LogWarning("Could not delete {StorageKey} of deleted user {UserId}; the orphan sweep will", key, userId);
        await DeleteStoredAsync("DeleteUserDirectory", () => storage.DeleteUserDirectoryAsync(userId, ct));
        if (UserAccount.IsStoredPicture(picture))
            await DeleteStoredAsync("DeleteAvatar", () => storage.DeleteFileAsync(picture!, ct));
        return deleted;

        // An orphan file is recoverable, but it must be observable.
        async Task DeleteStoredAsync(string operation, Func<Task> delete)
        {
            try
            {
                await delete();
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning(ex, "Account {UserId} deleted but storage cleanup failed for {Operation}", userId, operation);
            }
        }
    }
}
