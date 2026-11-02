using Domain.Identity;
using Npgsql;

namespace Application.Identity;

/// <summary>
/// The guest→account merge on <c>textstack_v2</c> (v2-sync-protocol.md "Guest → account merge"): a
/// cross-user system operation with its own name (data-access.md rule 7), because it moves every
/// aggregate of one user to another.
/// </summary>
public interface IAccountMergeRepository
{
    /// <summary>
    /// Moves everything <paramref name="guestId"/> owns to <paramref name="accountId"/> and deletes the
    /// guest, in one transaction: <paramref name="tx"/>'s (commit stays the caller's), else its own.
    /// <list type="bullet">
    /// <item>The caller has signed <paramref name="accountId"/> in: its V2 guest flag, if any, is cleared.</item>
    /// <item>Concurrent merges of one guest: one <see cref="AccountMergeOutcome.Merged"/>, the rest
    /// <see cref="AccountMergeOutcome.NoGuest"/>; so is a re-run.</item>
    /// <item><see cref="AccountMergeOutcome.Refused"/> (not a guest, no account, one id) moves nothing.</item>
    /// <item>Rows keep their ids, except what <see cref="AccountMerge"/>'s maps name: a book whose current
    /// file holds the bytes of a live account book's merges into it, and a card into the account's card
    /// of the same language and key. Guest copies of the account's operations are dropped.</item>
    /// <item>The guest's credentials die with it: sessions, reset codes, device logins, OAuth requests
    /// and grants, MCP keys. Its agent runs move.</item>
    /// <item>An insight that loses a (book, chapter) clash is kept in full as a checkpoint; only its
    /// review questions' schedules are lost (<see cref="AccountMerge.UnscheduledReviewQuestions"/>).</item>
    /// </list>
    /// A unique key an account device writes while the merge runs can still abort it (23505): a re-run
    /// with a fresh snapshot settles it.
    /// </summary>
    Task<AccountMerge> MergeAsync(Guid guestId, Guid accountId, NpgsqlTransaction? tx, CancellationToken ct);
}
