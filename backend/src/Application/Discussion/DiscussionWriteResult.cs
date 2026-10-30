namespace Application.Discussion;

/// <summary>
/// How a replayable discussion write (a share or a checkpoint) ended. A retry is told from a
/// different write by <c>PayloadSha256</c>, which the caller computes and the repository stores and
/// compares (docs/01-architecture/v2-sync-protocol.md).
/// </summary>
public enum DiscussionWriteOutcome
{
    /// <summary>A new row was stored.</summary>
    Created,

    /// <summary>A retry: the operation id was already stored with the same payload hash; nothing new was written.</summary>
    Replayed,

    /// <summary>The operation id was already stored with a different payload hash; nothing was written (HTTP 409).</summary>
    OperationConflict,

    /// <summary>
    /// Checkpoints only: the named share is missing (or not the user's), or of another chapter or
    /// file version; nothing was written.
    /// </summary>
    ShareMismatch,
}

/// <summary>
/// <see cref="Stored"/> is the row under the operation id: the new one (<see cref="DiscussionWriteOutcome.Created"/>),
/// the original one (<see cref="DiscussionWriteOutcome.Replayed"/>, <see cref="DiscussionWriteOutcome.OperationConflict"/>),
/// or null (<see cref="DiscussionWriteOutcome.ShareMismatch"/>).
/// </summary>
public sealed record DiscussionWriteResult<T>(DiscussionWriteOutcome Outcome, T? Stored) where T : class;
