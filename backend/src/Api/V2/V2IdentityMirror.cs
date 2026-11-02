using Application.Common.Interfaces;
using Application.Identity;
using Domain.Identity;

namespace Api.V2;

public enum V2MirrorStatus { Mirrored, Skipped, Failed }

/// <summary>What the mirror did: <see cref="Reason"/> says why it skipped (a code) or failed (the exception type); <see cref="Merge"/> is the merge's result.</summary>
public sealed record V2MirrorResult(V2MirrorStatus Status, string? Reason = null, AccountMerge? Merge = null);

/// <summary>
/// The legacy account delete and guest merge, repeated on <c>textstack_v2</c> after the legacy commit
/// (M2.5a). Legacy stays the system of record and decides the outcome: with <c>Features:V2Api</c> off
/// nothing is called, a V2 that is not ready (<see cref="V2Readiness"/>'s cached answer) is skipped, and
/// a V2 failure is logged at Error and returned, never thrown. There is no outbox: a failed mirror
/// loses the guest's V2-only rows, and the M3 ETL pre-flight sweeps V2 users with no legacy row (#1094).
/// </summary>
public sealed class V2IdentityMirror(
    IConfiguration config, V2Readiness readiness, V2ShadowUsers shadows, IUserRepository users,
    IAccountMergeRepository merges, IAppDbContext legacy, ILogger<V2IdentityMirror> logger)
{
    public Task<V2MirrorResult> DeleteAsync(Guid userId, CancellationToken ct) => MirrorAsync(userId, userId, async () =>
    {
        await users.DeleteAsync(userId, ct);
        shadows.Forget(userId);
        return new V2MirrorResult(V2MirrorStatus.Mirrored);
    });

    /// <summary>Only after legacy merged the guest: the account's V2 row is made if it has none, then the guest's rows move to it.</summary>
    public Task<V2MirrorResult> MergeAsync(Guid guestId, Guid accountId, CancellationToken ct) => MirrorAsync(guestId, accountId, async () =>
    {
        if (!await shadows.EnsureAsync(legacy, accountId, ct)) return new V2MirrorResult(V2MirrorStatus.Skipped, "account_email_taken");
        // Legacy just signed this account in, so it is no guest; its V2 row may still say so (a guest
        // promoted in place keeps its shadow's flag), and the merge refuses a guest as the target.
        await users.ClearGuestFlagAsync(accountId, ct);
        var merged = await merges.MergeAsync(guestId, accountId, null, ct);
        shadows.Forget(guestId);
        if (merged.Outcome == AccountMergeOutcome.Refused) return new V2MirrorResult(V2MirrorStatus.Skipped, "merge_refused", merged);
        if (merged.HashAnomalies > 0)
            logger.LogWarning("V2 merge {GuestUserId} → {UserId}: {HashAnomalies} guest copies of the account's operations carried another payload",
                guestId, accountId, merged.HashAnomalies);
        return new V2MirrorResult(V2MirrorStatus.Mirrored, Merge: merged);
    });

    private async Task<V2MirrorResult> MirrorAsync(Guid subjectId, Guid userId, Func<Task<V2MirrorResult>> mirror)
    {
        if (!config.GetValue<bool>("Features:V2Api")) return new V2MirrorResult(V2MirrorStatus.Skipped, "flag_off");
        try
        {
            if (!(await readiness.GetAsync()).IsReady) return new V2MirrorResult(V2MirrorStatus.Skipped, "v2_not_ready");
            return await mirror();
        }
        catch (Exception e)
        {
            logger.LogError(e, "V2 identity mirror failed for {SubjectUserId} → {UserId}; legacy is done, V2 keeps the rows until the ETL sweep (#1094)",
                subjectId, userId);
            return new V2MirrorResult(V2MirrorStatus.Failed, e.GetType().Name);
        }
    }
}
