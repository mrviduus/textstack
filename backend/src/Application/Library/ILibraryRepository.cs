using Domain.Library;

namespace Application.Library;

/// <summary>
/// The V2 library (tables <c>books</c> + <c>book_files</c>, one aggregate; ADR-031). Every method is
/// scoped to <c>userId</c>: another user's ids read as "not found" and change nothing
/// (docs/01-architecture/data-access.md rule 7).
/// </summary>
public interface ILibraryRepository
{
    /// <summary>The user's books that are not removed, newest first, each with its current file.</summary>
    Task<IReadOnlyList<Book>> ListAsync(Guid userId, CancellationToken ct);

    /// <summary>One of the user's books, removed or not, with its current file; null when not the user's.</summary>
    Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>
    /// The user's oldest book, not removed, whose current file has these bytes; null when none.
    /// Another user's identical file is not a duplicate.
    /// </summary>
    Task<Book?> FindBySha256Async(Guid userId, string sha256, CancellationToken ct);

    /// <summary>
    /// Inserts a book and its first file in one transaction; the file is stored under the book's
    /// user and id, whatever its own say. Returns the stored book with its current file.
    /// </summary>
    Task<Book> ImportAsync(Book book, BookFile file, CancellationToken ct);

    /// <summary>
    /// Makes <paramref name="file"/> the book's current version, in one transaction: the old version
    /// stays as a non-current row, and the reading state is reset, since it belongs to the old
    /// version (ADR-031). Null when the book is not the user's or is removed. The superseded file
    /// is returned so a job can delete its bytes later.
    /// </summary>
    Task<FileReplacement?> ReplaceFileAsync(Guid userId, Guid bookId, BookFile file, CancellationToken ct);

    /// <summary>Hides the book (sets <c>removed_at</c>); false when not the user's or already removed.</summary>
    Task<bool> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>Un-hides a removed book; false when not the user's or not removed.</summary>
    Task<bool> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct);
}

/// <summary>The new current file, and the one it replaced (null when the book had none).</summary>
public sealed record FileReplacement(BookFile Current, BookFile? Superseded);
