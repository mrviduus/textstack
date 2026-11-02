using Application.Common.Interfaces;
using Application.Identity;
using Domain.Identity;
using Npgsql;

namespace Api.V2;

public enum V2MirrorStatus { Mirrored, Skipped, Failed }

/// <summary>What the mirror did: <see cref="Reason"/> says why it skipped (a code) or failed (the exception type); <see cref="Merge"/> is the merge's result.</summary>
public sealed record V2MirrorResult(V2MirrorStatus Status, string? Reason = null, AccountMerge? Merge = null);

/// <summary>
/// The legacy account delete, guest merge and guest promotion, repeated on <c>textstack_v2</c> after
/// the legacy commit (M2.5a). Legacy stays the system of record and decides the outcome: with
/// <c>Features:V2Api</c> off nothing is called, a V2 that is not ready (<see cref="V2Readiness"/>'s
/// cached answer) is skipped, and a V2 failure is logged at Error and returned, never thrown. It runs
/// on its own <see cref="Timeout"/>, not the request's token: a client gone after the legacy commit
/// must not roll it back, and legacy waits on V2 at most that long. There is no outbox: a failed
/// mirror loses the guest's V2-only rows, and the M3 ETL pre-flight sweeps V2 users with no legacy
/// row (#1094).
/// </summary>
public sealed class V2IdentityMirror(
    IConfiguration config, V2Readiness readiness, V2ShadowUsers shadows, IUserRepository users,
    IAccountMergeRepository merges, IAppDbContext legacy, ILogger<V2IdentityMirror> logger)
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(10);

    public Task<V2MirrorResult> DeleteAsync(Guid userId) => MirrorAsync(userId, userId, async ct =>
    {
        await users.DeleteAsync(userId, ct);
        shadows.Forget(userId);
        return new V2MirrorResult(V2MirrorStatus.Mirrored);
    });

    /// <summary>
    /// Only after legacy merged the guest (<paramref name="legacyMerged"/>): the account's V2 row is
    /// made if it has none, then the guest's rows move to it.
    /// </summary>
    public Task<V2MirrorResult> MergeAsync(Guid guestId, Guid accountId, bool legacyMerged)
    {
        if (!legacyMerged) return Task.FromResult(new V2MirrorResult(V2MirrorStatus.Skipped, "legacy_not_merged"));
        return MirrorAsync(guestId, accountId, async ct =>
        {
            if (!await shadows.EnsureAsync(legacy, accountId, ct)) return Stranded("account_email_taken", guestId, accountId);
            // Legacy just signed this account in, so it is no guest. Its V2 row may still say so when
            // PromoteAsync failed for it, and the merge refuses a guest as the target: the fallback.
            await users.ClearGuestFlagAsync(accountId, ct);
            var merged = await merges.MergeAsync(guestId, accountId, null, ct);
            shadows.Forget(guestId);
            if (merged.Outcome == AccountMergeOutcome.Refused) return Stranded("merge_refused", guestId, accountId) with { Merge = merged };
            if (merged.HashAnomalies > 0)
                logger.LogWarning("V2 merge {GuestUserId} → {UserId}: {HashAnomalies} guest copies of the account's operations carried another payload",
                    guestId, accountId, merged.HashAnomalies);
            return new V2MirrorResult(V2MirrorStatus.Mirrored, Merge: merged);
        });
    }

    /// <summary>A guest registered in place (legacy promoted it): its V2 row becomes the account. No V2 row: nothing to do.</summary>
    public Task<V2MirrorResult> PromoteAsync(Guid userId, string email, string? name, string passwordHash) => MirrorAsync(userId, userId, async ct =>
    {
        var promoted = await users.PromoteGuestAsync(userId, email, name, passwordHash, ct);
        return promoted.Outcome switch
        {
            AccountUpdateOutcome.Updated => new V2MirrorResult(V2MirrorStatus.Mirrored),
            AccountUpdateOutcome.EmailTaken => Stranded("email_taken", userId, userId),
            _ => new V2MirrorResult(V2MirrorStatus.Skipped, "no_v2_guest"),
        };
    });

    /// <summary>A skip that leaves V2 rows behind: as loud as a failure.</summary>
    private V2MirrorResult Stranded(string reason, Guid subjectId, Guid userId)
    {
        logger.LogError("V2 identity mirror skipped ({Reason}) for {SubjectUserId} → {UserId}: V2 rows are left behind until the ETL sweep (#1094)",
            reason, subjectId, userId);
        return new V2MirrorResult(V2MirrorStatus.Skipped, reason);
    }

    private async Task<V2MirrorResult> MirrorAsync(Guid subjectId, Guid userId, Func<CancellationToken, Task<V2MirrorResult>> mirror)
    {
        if (!config.GetValue<bool>("Features:V2Api")) return new V2MirrorResult(V2MirrorStatus.Skipped, "flag_off");
        using var timeout = new CancellationTokenSource(Timeout);
        try
        {
            if (!(await readiness.GetAsync()).IsReady) return new V2MirrorResult(V2MirrorStatus.Skipped, "v2_not_ready");
            try
            {
                return await mirror(timeout.Token);
            }
            // A fresh snapshot settles these: a device of the account wrote the same unique key while
            // the merge ran (the plan's "retry once"), or two transactions crossed.
            catch (PostgresException e) when (e.SqlState is PostgresErrorCodes.UniqueViolation or PostgresErrorCodes.DeadlockDetected
                                                  or PostgresErrorCodes.SerializationFailure)
            {
                return await mirror(timeout.Token);
            }
        }
        catch (Exception e)
        {
            // Not a Postgres answer: the connection itself failed, so the next V2 request re-checks readiness.
            if (e is NpgsqlException and not PostgresException) readiness.Invalidate();
            logger.LogError(e, "V2 identity mirror failed for {SubjectUserId} → {UserId}; legacy is done, V2 keeps the rows until the ETL sweep (#1094)",
                subjectId, userId);
            return new V2MirrorResult(V2MirrorStatus.Failed, e.GetType().Name);
        }
    }
}
