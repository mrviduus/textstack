using Domain.Annotations;

namespace Application.Annotations;

/// <summary>
/// The V2 annotations (table <c>annotations</c>, ADR-031), guarded by <c>revision</c> so a stale device
/// cannot overwrite a newer one. Every method is scoped to <c>userId</c>: another user's ids read as
/// "not found" and change nothing (docs/01-architecture/data-access.md rule 7).
/// </summary>
public interface IAnnotationRepository
{
    /// <summary>The user's annotations in the book that are not deleted, oldest first.</summary>
    Task<IReadOnlyList<Annotation>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>One of the user's annotations, deleted or not; null when not the user's.</summary>
    Task<Annotation?> GetAsync(Guid userId, Guid id, CancellationToken ct);

    /// <summary>
    /// Writes <paramref name="annotation"/> if the caller saw the latest one: <paramref name="expectedRevision"/>
    /// is null for a first write (into one of the user's books), else the revision the caller last read.
    /// A stale write is not an error, it loses: the result carries the stored annotation (null when
    /// there is none, or it is not the user's). A deleted annotation is final: every write to it loses,
    /// even one naming its current revision, so a device that missed the delete cannot bring it back.
    /// The book is fixed at the first write; a file that is not a version of it loses too. A locator
    /// without a file is refused by the schema (a <c>PostgresException</c>), as a broken invariant.
    /// </summary>
    /// <exception cref="ArgumentException">The annotation names another user.</exception>
    Task<SaveAnnotationResult> SaveAsync(Guid userId, Annotation annotation, long? expectedRevision, CancellationToken ct);

    /// <summary>Soft-deletes (sets <c>deleted_at</c>, bumps the revision); false when not the user's or already deleted.</summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}

/// <summary>
/// <see cref="Accepted"/>: <see cref="Current"/> is the stored annotation with its new revision.
/// Otherwise the write lost and <see cref="Current"/> is what is stored instead (null: nothing).
/// </summary>
public sealed record SaveAnnotationResult(bool Accepted, Annotation? Current);
