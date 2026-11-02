using Application.Common;
using Domain.Library;
using Npgsql;

namespace Application.Library;

/// <summary>
/// The V2 library (tables <c>books</c> + <c>book_files</c>, one aggregate; ADR-031). Every method is
/// scoped to <c>userId</c>: another user's ids read as "not found" and change nothing
/// (docs/01-architecture/data-access.md rule 7). Every write bumps <c>books.updated_at</c>, the
/// library feed's watermark (v2-sync-protocol.md "Pull and push").
/// </summary>
public interface ILibraryRepository
{
    /// <summary>The user's books that are not removed, newest first, each with its current file.</summary>
    Task<IReadOnlyList<Book>> ListAsync(Guid userId, CancellationToken ct);

    /// <summary>One of the user's books, removed or not, with its current file; null when not the user's.</summary>
    Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>A version of the user's book, current or superseded; null when it is not one of this book's.</summary>
    Task<BookFile?> GetFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>
    /// The user's oldest book, not removed, whose current file has these bytes; null when none.
    /// Another user's identical file is not a duplicate.
    /// </summary>
    Task<Book?> FindBySha256Async(Guid userId, string sha256, CancellationToken ct);

    /// <summary>
    /// The user's books changed after <c>(since, afterId)</c>, removed ones included, ordered by
    /// <c>(updated_at, id)</c>, each with its current file: one page of the library feed.
    /// </summary>
    Task<IReadOnlyList<Book>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct);

    /// <summary>
    /// Imports a book and its first file under <paramref name="userId"/>, replay-safe (#1065): the
    /// same import again is <see cref="ImportOutcome.Replayed"/> — also after a replacement, as long
    /// as <paramref name="file"/> is any version of the stored book. Another live book of the user
    /// whose current file has these bytes wins (<see cref="ImportOutcome.DuplicateFile"/>); a book or
    /// file id held by anything else is <see cref="ImportOutcome.IdConflict"/>.
    /// </summary>
    Task<ImportResult> ImportAsync(Guid userId, Book book, BookFile file, CancellationToken ct);

    /// <summary>
    /// Replaces the book's metadata if the caller saw the latest (<paramref name="expectedRevision"/>):
    /// revision + 1. A stale edit loses and carries the stored book (owner decision 5).
    /// </summary>
    Task<RevisionedWrite<Book>> UpdateMetadataAsync(
        Guid userId, Guid bookId, BookMetadata metadata, long expectedRevision, CancellationToken ct);

    /// <summary>
    /// Makes <paramref name="file"/> the book's current version if the caller saw the current one:
    /// <paramref name="replacesFileId"/> is the stored current file, or null for a book with none
    /// (M1.2 delta 2b). The old version stays as a non-current row. Composes with the reading-state
    /// delete through <paramref name="tx"/> (#1067); without one it runs in its own.
    /// </summary>
    Task<FileReplacement> ReplaceFileAsync(
        Guid userId, Guid bookId, BookFile file, Guid? replacesFileId, NpgsqlTransaction? tx, CancellationToken ct);

    /// <summary>Hides the book (sets <c>removed_at</c>); false when not the user's or already removed.</summary>
    Task<bool> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>Un-hides a removed book; false when not the user's or not removed.</summary>
    Task<bool> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct);
}

/// <summary>The fields a client edits (<c>PATCH /books/{bookId}</c>); written whole.</summary>
public sealed record BookMetadata(
    string Title, string? Author, string? Language, string? Description, string? Genre, int? PublishedYear, string[] Tags);

public enum ImportOutcome
{
    Created,

    /// <summary>The book is already the user's and the file one of its versions: nothing changed.</summary>
    Replayed,

    /// <summary>Another live book of the user has these bytes as its current file: nothing changed.</summary>
    DuplicateFile,

    /// <summary>The book id, or the file id, belongs to something else (perhaps another user's): nothing changed.</summary>
    IdConflict,
}

/// <summary>The stored book (<see cref="ImportOutcome.Created"/>, <see cref="ImportOutcome.Replayed"/>), the duplicate, or null.</summary>
public sealed record ImportResult(ImportOutcome Outcome, Book? Book);

public enum FileReplaceOutcome
{
    /// <summary><see cref="FileReplacement.Current"/> is the new file, <see cref="FileReplacement.Superseded"/> the one it replaced (null: there was none).</summary>
    Replaced,

    /// <summary>The file is already the book's current one: nothing changed.</summary>
    Replayed,

    /// <summary>The caller's view is stale (its <c>replacesFileId</c> is not current, or the file is a superseded version): <see cref="FileReplacement.Current"/> is the book's current file.</summary>
    FileReplaced,

    BookRemoved,
    NotFound,

    /// <summary>The file id belongs to another book (perhaps another user's).</summary>
    IdConflict,
}

public sealed record FileReplacement(FileReplaceOutcome Outcome, BookFile? Current = null, BookFile? Superseded = null);
