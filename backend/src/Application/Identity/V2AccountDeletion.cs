using Application.Library;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// Deletes a V2 account with its bytes: the account delete on V2, the identity mirror following a
/// legacy delete, and the guest reaper. One place, so the bytes cannot be forgotten by one of them
/// (QA of M2.6: expired guests' books, covers and parts stayed forever).
/// </summary>
public sealed class V2AccountDeletion(IUserRepository users, ILibraryRepository library, ILibraryFileStore files, ILogger<V2AccountDeletion> logger)
{
    /// <summary>
    /// The users cascade drops the rows; the account's bytes go after it, best-effort: its own directories,
    /// then any key it held elsewhere (listed before the delete: after a merge some sit under the former
    /// guest's directory; the rest are already gone, a cheap no-op). What fails here the orphan sweep
    /// collects. False when there was no such account (its directories are still swept).
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
