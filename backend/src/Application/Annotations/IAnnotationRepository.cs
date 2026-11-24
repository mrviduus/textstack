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

    /// <summary>
    /// The all-highlights list: the user's live annotations (a removed book's too), newest first (or oldest), filtered by
    /// <paramref name="search"/> (in the text or the note, case-insensitive) and <paramref name="color"/>, one page,
    /// with the total before paging. Each row carries its book's title and, when the locator names a chapter of the
    /// book's current file, that chapter.
    /// </summary>
    Task<AnnotationPage> ListAllAsync(Guid userId, string? search, string? color, bool oldestFirst, int limit, int offset, CancellationToken ct);

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

/// <summary>
/// One row of <see cref="IAnnotationRepository.ListAllAsync"/>. <c>AnchorJson</c> is legacy's anchor: the quote with its
/// context for an <c>epub-cfi</c> locator, the locator's object value otherwise (a PDF one marked <c>kind: pdf</c>), else
/// <c>{}</c>. <c>BookRemoved</c>: the book is in the trash, <c>BookTitle</c> the title it had. <c>BookCoverVersion</c>: the book's
/// <c>updated_at</c> when it has a cover (the cover URL's cache key), else null.
/// </summary>
public sealed record AnnotationListItem(
    Guid Id, string SelectedText, string AnchorJson, string Color, string? NoteText, DateTimeOffset CreatedAt,
    Guid BookId, string BookTitle, bool BookRemoved, Guid? ChapterId, string? ChapterTitle, string? ChapterKey,
    DateTimeOffset? BookCoverVersion = null);

public sealed record AnnotationPage(int TotalCount, IReadOnlyList<AnnotationListItem> Items);
