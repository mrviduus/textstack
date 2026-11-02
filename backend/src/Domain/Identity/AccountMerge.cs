namespace Domain.Identity;

/// <summary>What a guest→account merge did (v2-sync-protocol.md "Guest → account merge").</summary>
public enum AccountMergeOutcome
{
    Merged,

    /// <summary>No such guest: it never had V2 rows, or it is already merged (a re-run lands here, not in an error).</summary>
    NoGuest,

    /// <summary>Nothing moved: the guest is not a guest, the account is missing, or the two ids are one.</summary>
    Refused,
}

/// <summary>
/// The merge's result. <see cref="Books"/>, <see cref="Files"/> and <see cref="Words"/> map the guest
/// ids that did not survive to the account's that replaced them (matched books, same-bytes files,
/// same-key words); every other row kept its id (owner decision 12). <see cref="DroppedDuplicates"/>:
/// guest copies of an operation the account already holds (<see cref="HashAnomalies"/> of them with
/// another payload). <see cref="UnscheduledReviewQuestions"/>: review questions of an insight that
/// lost a clash; their text lives on in its checkpoint, their review schedule does not.
/// </summary>
public sealed record AccountMerge(
    AccountMergeOutcome Outcome,
    IReadOnlyDictionary<Guid, Guid> Books,
    IReadOnlyDictionary<Guid, Guid> Files,
    IReadOnlyDictionary<Guid, Guid> Words,
    int DroppedDuplicates,
    int HashAnomalies,
    int UnscheduledReviewQuestions)
{
    private static readonly IReadOnlyDictionary<Guid, Guid> None = new Dictionary<Guid, Guid>();

    public static readonly AccountMerge NoGuest = Empty(AccountMergeOutcome.NoGuest);
    public static readonly AccountMerge Refused = Empty(AccountMergeOutcome.Refused);

    /// <summary>The outcome with no id remapped and nothing dropped.</summary>
    public static AccountMerge Empty(AccountMergeOutcome outcome) => new(outcome, None, None, None, 0, 0, 0);
}
