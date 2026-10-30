using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The V2 chapter shares (table <c>shared_chapters</c>, ADR-031): immutable snapshots, so there is no
/// update; sharing again is a new row. Every method is scoped to <c>userId</c>: another user's ids read
/// as "not found" and change nothing (docs/01-architecture/data-access.md rule 7).
/// <para>Input validation (JSON shape, hash format, text lengths, enum values) is the API's job: a caller
/// bug surfaces from the repository as the schema's <c>PostgresException</c> (data-access.md rule 8).</para>
/// </summary>
public interface ISharedChapterRepository
{
    /// <summary>
    /// Stores <paramref name="share"/> once per <c>(UserId, OperationId)</c>: a retry with the same
    /// <c>PayloadSha256</c> returns the stored row, a different hash under that operation id is a
    /// conflict. A file that is not of the share's book is refused by the
    /// schema (<c>PostgresException</c> 23503), as a broken invariant.
    /// </summary>
    Task<DiscussionWriteResult<SharedChapter>> ShareAsync(SharedChapter share, CancellationToken ct);

    /// <summary>One of the user's shares; null when not the user's.</summary>
    Task<SharedChapter?> GetAsync(Guid userId, Guid id, CancellationToken ct);

    /// <summary>The user's shares of one book, newest first.</summary>
    Task<IReadOnlyList<SharedChapter>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>
    /// Deletes the share in one transaction, after unlinking the checkpoints based on it (their text
    /// stays; plan §4.4). False when not the user's. The unlink could move into the FK
    /// (<c>ON DELETE SET NULL (shared_chapter_id)</c>), a migration-0001 candidate; see the PR Notes.
    /// </summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}
