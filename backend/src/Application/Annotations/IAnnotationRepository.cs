using Application.Common;
using Domain.Annotations;

namespace Application.Annotations;

/// <summary>
/// The V2 annotations (table <c>annotations</c>, ADR-031), guarded by <c>revision</c> so a stale device
/// cannot overwrite a newer one. Every method is scoped to <c>userId</c>: another user's ids read as
/// "not found" and change nothing (docs/architecture/data-access.md rule 7). Input validation
/// (locator JSON shape, text lengths, non-blank text, a color) is the API's job: a caller bug surfaces
/// as a <c>PostgresException</c> from the schema (data-access.md rule 8).
/// </summary>
public interface IAnnotationRepository
{
    /// <summary>The user's annotations in the book that are not deleted, oldest first.</summary>
    Task<IReadOnlyList<Annotation>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>One of the user's annotations, deleted or not; null when not the user's.</summary>
    Task<Annotation?> GetAsync(Guid userId, Guid id, CancellationToken ct);

    /// <summary>
    /// The user's annotations changed after <c>(since, afterId)</c>, tombstones included, ordered by
    /// <c>(updated_at, id)</c>: one page of the annotations feed.
    /// </summary>
    Task<IReadOnlyList<Annotation>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct);

    /// <summary>
    /// Writes <paramref name="annotation"/> if the caller saw the latest one: <paramref name="expectedRevision"/>
    /// is null for a first write (into one of the user's books), else the revision the caller last read.
    /// A stale write is not an error, it loses: the result carries the stored annotation (null when
    /// there is none, or it is not the user's). A deleted annotation is final: every write to it loses,
    /// even one naming its current revision, so a device that missed the delete cannot bring it back.
    /// The book is fixed at the first write: an edit naming another book loses. A book or file that is
    /// not the user's, a file of another book, or a locator without a file is refused by the schema (a
    /// <c>PostgresException</c>), as a broken invariant: the endpoint checks them first, since it must
    /// tell <c>unknown_file</c> from <c>file_replaced</c> anyway.
    /// It is stored under <paramref name="userId"/>, whatever <c>annotation.UserId</c> says.
    /// </summary>
    Task<RevisionedWrite<Annotation>> SaveAsync(Guid userId, Annotation annotation, long? expectedRevision, CancellationToken ct);

    /// <summary>
    /// Soft-deletes (sets <c>deleted_at</c>, bumps the revision) and returns the tombstone; one deleted
    /// before is returned as it is. Null when not the user's.
    /// </summary>
    Task<Annotation?> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}
