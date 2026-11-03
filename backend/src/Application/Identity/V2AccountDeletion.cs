using Application.Library;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// Deletes a V2 account with its bytes: the account delete on V2, the identity mirror following a
/// legacy delete, and the guest reaper. One place, so the bytes cannot be forgotten by one of them
/// (QA of M2.6: expired guests' books, covers and parts stayed forever).
/// </summary>
public sealed class V2AccountDeletion(IUserRepository users, IAccountMergeRepository aggregates, ILibraryRepository library, ILibraryFileStore files, ILogger<V2AccountDeletion> logger)
{
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
    /// rest are already gone, a cheap no-op). A failure before the delete touches nothing; a byte left
    /// behind the orphan sweep collects. False when there was no such account (its directories are
    /// still swept).
    /// </summary>
    public async Task<bool> DeleteAsync(Guid userId, CancellationToken ct)
    {
        var keys = await library.ListStorageKeysAsync(userId, ct);
        var deleted = await users.DeleteAsync(userId, ct);
        files.DeleteUser(userId);
        foreach (var key in keys)
            if (!files.TryDelete(key)) logger.LogWarning("Could not delete {StorageKey} of deleted user {UserId}; the orphan sweep will", key, userId);
        return deleted;
    }
}
