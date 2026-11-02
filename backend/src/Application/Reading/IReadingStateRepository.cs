using Application.Common;
using Domain.Reading;
using Npgsql;

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
    Task<RevisionedWrite<ReadingState>> AdvanceAsync(
        Guid userId, Guid bookId, ReadingState state, long? expectedRevision, CancellationToken ct);

    /// <summary>
    /// The explicit way back to the start, guarded like a write (M1.2 delta 2a): forgets the frontier
    /// and completion, keeps the position, and bumps the revision, so every other device's revision is
    /// now stale; the new revision is also recorded as <see cref="ReadingState.ResetRevision"/>, so a
    /// stale writer can be told it lost to a reset. A stale reset loses and carries the stored state
    /// (null when there is none).
    /// </summary>
    Task<RevisionedWrite<ReadingState>> ResetAsync(Guid userId, Guid bookId, long expectedRevision, CancellationToken ct);

    /// <summary>
    /// Deletes the state taken in <paramref name="fileId"/>, whose locators mean nothing in another
    /// version: the replacement use case runs it in the replacement's transaction (#1067). False when
    /// there was none.
    /// </summary>
    Task<bool> DeleteForFileAsync(Guid userId, Guid bookId, Guid fileId, NpgsqlTransaction? tx, CancellationToken ct);

    /// <summary>
    /// The user's states changed after <c>(since, afterBookId)</c>, ordered by <c>(updated_at, book_id)</c>:
    /// one page of the reading feed.
    /// </summary>
    Task<IReadOnlyList<ReadingState>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterBookId, int limit, CancellationToken ct);
}
