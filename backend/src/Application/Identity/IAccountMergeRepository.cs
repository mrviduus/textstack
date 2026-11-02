using Domain.Identity;
using Npgsql;

namespace Application.Identity;

/// <summary>
/// The guest→account merge on <c>textstack_v2</c> (M2.5, plan §6.1): a cross-user system operation
/// with its own name (data-access.md rule 7), because it moves every aggregate of one user to another.
/// </summary>
public interface IAccountMergeRepository
{
    /// <summary>
    /// Moves everything <paramref name="guestId"/> owns to <paramref name="accountId"/> and deletes the
    /// guest, in one transaction: <paramref name="tx"/>'s (commit stays the caller's), else its own.
    /// Both users are locked first, so a second merge of the same guest waits, then answers
    /// <see cref="AccountMergeOutcome.NoGuest"/>.
    /// </summary>
    Task<AccountMerge> MergeAsync(Guid guestId, Guid accountId, NpgsqlTransaction? tx, CancellationToken ct);
}
