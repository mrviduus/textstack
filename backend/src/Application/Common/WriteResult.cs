namespace Application.Common;

/// <summary>What became of a write keyed by an operation id (v2-sync-protocol.md, "operation_id rules").</summary>
public enum WriteOutcome
{
    /// <summary>First time this operation was seen: the row was stored.</summary>
    Created,

    /// <summary>A retry of a stored operation with the same payload: nothing changed.</summary>
    Replayed,

    /// <summary>The operation id is taken by a different payload: nothing changed (409 <c>operation_conflict</c>).</summary>
    OperationConflict,

    /// <summary>A new operation on a deleted parent: nothing changed (409 <c>deleted</c>).</summary>
    Deleted,

    /// <summary>A new operation on a parent the user does not have: nothing changed (404 <c>not_found</c>).</summary>
    NotFound,

    /// <summary>Checkpoints only: the share it names is missing, of another chapter or of another file version.</summary>
    ShareMismatch,
}

/// <summary>
/// The outcome of an idempotent write and the stored row under its operation id: the new row
/// (<see cref="WriteOutcome.Created"/>), the one already there (<see cref="WriteOutcome.Replayed"/>,
/// <see cref="WriteOutcome.OperationConflict"/>), or null (every outcome that stored nothing).
/// </summary>
public sealed record WriteResult<T>(WriteOutcome Outcome, T? Row);
