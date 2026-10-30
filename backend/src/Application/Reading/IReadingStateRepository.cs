using Domain.Reading;

namespace Application.Reading;

/// <summary>
/// The V2 reading state (table <c>reading_state</c>, ADR-031): one row per user and book, guarded by
/// <c>revision</c> so a stale device cannot overwrite a newer one. Every method is scoped to
/// <c>userId</c> (docs/01-architecture/data-access.md rule 7). A removed book still accepts state:
/// a device reading offline may sync after the removal, and the row goes with the book on hard delete.
/// </summary>
public interface IReadingStateRepository
{
    /// <summary>The user's state in the book; null when there is none.</summary>
    Task<ReadingState?> GetAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>
    /// Writes <paramref name="state"/> if the caller saw the latest one: <paramref name="expectedRevision"/>
    /// is null for a first write, else the revision the caller last read. A stale write is not an
    /// error, it loses: the result carries the state that won (null when there is none). The
    /// frontier never moves back, and a write for a file that is not the book's current one (first
    /// write) or not the stored one (later writes) loses too.
    /// </summary>
    Task<AdvanceResult> AdvanceAsync(
        Guid userId, Guid bookId, ReadingState state, long? expectedRevision, CancellationToken ct);

    /// <summary>
    /// The explicit way back to the start: forgets the frontier and completion, keeps the position,
    /// and bumps the revision, so every other device's revision is now stale. Returns the new state
    /// (the caller's next expected revision); null when there was none.
    /// </summary>
    Task<ReadingState?> ResetAsync(Guid userId, Guid bookId, CancellationToken ct);
}

/// <summary>
/// <see cref="Accepted"/>: <see cref="Current"/> is the stored state with its new revision.
/// Otherwise the write lost and <see cref="Current"/> is what is stored instead (null: nothing).
/// </summary>
public sealed record AdvanceResult(bool Accepted, ReadingState? Current);
