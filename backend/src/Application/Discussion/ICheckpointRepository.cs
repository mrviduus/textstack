using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The V2 discussion checkpoints (table <c>discussion_checkpoints</c>, ADR-031): append-only, read in
/// bounded chronological pages (docs/01-architecture/mcp-discussion-checkpoints.md). Every method is
/// scoped to <c>userId</c> (docs/01-architecture/data-access.md rule 7).
/// <para>Input validation (JSON shape, hash format, text lengths, enum values) is the API's job: a caller
/// bug surfaces from the repository as the schema's <c>PostgresException</c> (data-access.md rule 8).</para>
/// </summary>
public interface ICheckpointRepository
{
    /// <summary>
    /// Appends <paramref name="checkpoint"/> once per <c>(UserId, OperationId)</c>: a retry with the
    /// same <c>PayloadSha256</c> returns the stored row, a different hash under that operation id is a conflict.
    /// A named share must be the user's, of the same book, chapter and file version, else
    /// <see cref="DiscussionWriteOutcome.ShareMismatch"/>. All four sections empty is refused by the
    /// schema (<c>PostgresException</c> 23514) as a broken invariant.
    /// </summary>
    Task<DiscussionWriteResult<DiscussionCheckpoint>> AppendAsync(DiscussionCheckpoint checkpoint, CancellationToken ct);

    /// <summary>
    /// Up to <paramref name="limit"/> of the user's checkpoints on one book, oldest first, after
    /// <paramref name="after"/> (null: from the start); <paramref name="chapterKey"/> null means every
    /// chapter and the book itself.
    /// </summary>
    Task<CheckpointPage> ListAsync(
        Guid userId, Guid bookId, string? chapterKey, int limit, CheckpointCursor? after, CancellationToken ct);

    /// <summary>False when not the user's.</summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}

/// <summary>Where a page ended: the last checkpoint's sort key.</summary>
public sealed record CheckpointCursor(DateTimeOffset CreatedAt, Guid Id);

/// <summary><see cref="Next"/> is null when this is the last page, else the cursor for the next one.</summary>
public sealed record CheckpointPage(IReadOnlyList<DiscussionCheckpoint> Items, CheckpointCursor? Next);
