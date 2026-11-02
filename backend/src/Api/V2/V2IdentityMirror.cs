using Application.Auth;
using Application.Common;
using Application.Common.Interfaces;
using Application.Identity;
using Application.Library;
using Domain.Identity;

namespace Api.V2;

/// <summary>
/// The legacy account delete, guest merge and guest promotion, repeated on <c>textstack_v2</c> after
/// the legacy commit (M2.5a); the caller runs it only when legacy did the same. Legacy stays the system
/// of record: with <c>Features:V2Api</c> off nothing is called, a V2 that is not ready
/// (<see cref="V2Readiness"/>'s cached answer) is skipped, and a V2 failure, or a skip that leaves V2
/// rows behind, is logged at Error with both ids, never thrown. It runs on its own
/// <see cref="Timeout"/>, not the request's token: a client gone after the legacy commit must not roll
/// it back, and legacy waits on V2 at most that long. There is no outbox: a failed mirror loses the
/// guest's V2-only rows, and the M3 ETL pre-flight sweeps V2 users with no legacy row (#1094).
/// </summary>
public sealed class V2IdentityMirror(
    IConfiguration config, V2Readiness readiness, V2ShadowUsers shadows, IUserRepository users, V2AccountDeletion deletion,
    IAccountMergeRepository merges, IAppDbContext legacy, ILibraryFileStore files, ILogger<V2IdentityMirror> logger)
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);

    /// <summary>The account's V2 rows and bytes (<see cref="V2AccountDeletion"/>).</summary>
    public Task DeleteAsync(Guid userId) => MirrorAsync(userId, userId, ct => deletion.DeleteAsync(userId, ct));

    /// <summary>A guest registered in place: its V2 row becomes the account. No V2 row: nothing to do.</summary>
    public Task PromoteAsync(Guid userId, string email, string? name, string passwordHash) => MirrorAsync(userId, userId, async ct =>
    {
        if ((await users.PromoteGuestAsync(userId, email, name, passwordHash, ct)).Outcome == AccountUpdateOutcome.EmailTaken)
            Stranded("email_taken", userId, userId);
    });

    /// <summary>
    /// The guest's V2 rows move to the account (its V2 row made first if it has none). Returns the ids
    /// the client must rewrite: null unless the merge ran and some id changed.
    /// </summary>
    public async Task<GuestMergeMap?> MergeAsync(Guid guestId, Guid accountId)
    {
        AccountMerge? merged = null;
        await MirrorAsync(guestId, accountId, async ct =>
        {
            if (!await shadows.EnsureAsync(legacy, accountId, ct))
            {
                Stranded("account_email_taken", guestId, accountId);
                return;
            }
            try
            {
                merged = await merges.MergeAsync(guestId, accountId, null, ct);
            }
            // A device of the account wrote the same unique key while the merge ran, or two
            // transactions crossed: a fresh snapshot settles both, once.
            catch (Exception e) when (e.IsUniqueViolation() || e.IsTransientConflict())
            {
                merged = await merges.MergeAsync(guestId, accountId, null, ct);
            }
            if (merged.Outcome == AccountMergeOutcome.Refused) Stranded("merge_refused", guestId, accountId);
            if (merged.Outcome == AccountMergeOutcome.Merged)
            {
                // Committed: the bytes no row names any more go now, best-effort (the orphan sweep is the backstop).
                foreach (var key in merged.ReleasedKeys)
                    if (!files.TryDelete(key)) logger.LogWarning("Could not delete {StorageKey} released by merging {GuestUserId} into {UserId}; the orphan sweep will", key, guestId, accountId);
                logger.LogInformation(
                    "V2 merge {GuestUserId} → {UserId}: {Books} books, {Files} files, {Words} words remapped; {DroppedDuplicates} guest copies dropped, "
                    + "{HashAnomalies} of them with another payload; {UnscheduledReviewQuestions} review questions unscheduled",
                    guestId, accountId, merged.Books.Count, merged.Files.Count, merged.Words.Count,
                    merged.DroppedDuplicates, merged.HashAnomalies, merged.UnscheduledReviewQuestions);
            }
        });
        return merged is { Outcome: AccountMergeOutcome.Merged } m && m.Books.Count + m.Files.Count + m.Words.Count > 0
            ? new GuestMergeMap(m.Books, m.Files, m.Words)
            : null;
    }

    private void Stranded(string reason, Guid subjectId, Guid userId) =>
        logger.LogError("V2 identity mirror skipped ({Reason}) for {SubjectUserId} → {UserId}: V2 rows are left behind until the ETL sweep (#1094)",
            reason, subjectId, userId);

    private async Task MirrorAsync(Guid subjectId, Guid userId, Func<CancellationToken, Task> mirror)
    {
        if (!config.GetValue<bool>("Features:V2Api")) return;
        using var timeout = new CancellationTokenSource(Timeout);
        try
        {
            if ((await readiness.GetAsync()).IsReady) await mirror(timeout.Token);
        }
        catch (Exception e)
        {
            readiness.Observe(e);
            logger.LogError(e, "V2 identity mirror failed for {SubjectUserId} → {UserId}; legacy is done, V2 keeps the rows until the ETL sweep (#1094)",
                subjectId, userId);
        }
    }
}
