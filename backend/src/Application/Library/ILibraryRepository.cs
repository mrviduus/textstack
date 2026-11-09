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

    /// <summary>Whether the book is the user's, removed or not.</summary>
    Task<bool> ExistsAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>The format of <paramref name="fileId"/> when it is a version of the user's book, current or superseded (no toc read); else null.</summary>
    Task<string?> FileFormatAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>A version of the user's book, current or superseded; null when it is not one of this book's.</summary>
    Task<BookFile?> GetFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>
    /// The user's oldest book, not removed, whose current file has these bytes; null when none.
    /// Another user's identical file is not a duplicate.
    /// </summary>
    Task<Book?> FindBySha256Async(Guid userId, string sha256, CancellationToken ct);

    /// <summary>
    /// The user's books changed after <c>(since, afterId)</c>, removed ones included, ordered by
    /// <c>(updated_at, id)</c>, each with its current file: one page of the library feed. Transitional
    /// (M6.4, #1118): only here does the file carry <see cref="BookFile.Ingestion"/>, <see cref="BookFile.ChapterCount"/>
    /// and <see cref="BookFile.WordCount"/>. Every job status write bumps <c>updated_at</c> (not <c>revision</c>), so the
    /// book re-enters a pull from an earlier cursor.
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
    /// (M1.2 delta 2b). The old version stays as a non-current row. Runs in <paramref name="tx"/> when
    /// given (it then neither commits nor rolls back), else in a transaction of its own.
    /// </summary>
    Task<FileReplacement> ReplaceFileAsync(
        Guid userId, Guid bookId, BookFile file, Guid? replacesFileId, NpgsqlTransaction? tx, CancellationToken ct);

    /// <summary>
    /// The per-book checkpoint opt-in; a removed book keeps it too. <c>updated_at</c> moves only when the
    /// value changes. The updated book; null when not the user's.
    /// </summary>
    Task<Book?> SetCheckpointSavingAsync(Guid userId, Guid bookId, bool enabled, CancellationToken ct);

    /// <summary>Hides the book (sets <c>removed_at</c>); false when not the user's or already removed.</summary>
    Task<bool> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>Un-hides a removed book; false when not the user's or not removed.</summary>
    Task<bool> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>
    /// Records that the server holds the bytes of the book's current file under <paramref name="storageKey"/>
    /// (PDD delta 4), if they fit: the user's stored bytes plus this file's stay within <paramref name="limitBytes"/>.
    /// Attaches of one user are serialized, so concurrent uploads cannot together pass the limit.
    /// Inside one transaction: lock, checks, the row update (uncommitted), then <paramref name="placeBytes"/>,
    /// then commit. A refused or lost attach places nothing; a failed place rolls the row back; a commit
    /// that fails after the place leaves bytes no row names, which the worker's orphan sweep deletes.
    /// Clears <c>content_removed_at</c> (a deliberate re-upload after "stop syncing" is allowed).
    /// </summary>
    Task<ContentAttachment> AttachContentAsync(
        Guid userId, Guid bookId, Guid fileId, string storageKey, long limitBytes, Action placeBytes, CancellationToken ct);

    /// <summary>
    /// "Stop syncing this file" (owner decision 6): the key cleared, <c>content_removed_at</c> stamped
    /// once, <c>updated_at</c> bumped; any version, current or not. Returns the key it cleared, whose bytes
    /// the caller then deletes; null when there was none (nothing stored, or not a version of the user's book).
    /// Clearing first means an attach committing meanwhile cannot have its new key cleared with its bytes
    /// left behind; a failed delete leaves bytes the orphan sweep collects.
    /// </summary>
    Task<string?> RemoveContentAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>The bytes the server holds for the user: the quota's "used" (owner decision 2).</summary>
    Task<long> StoredBytesAsync(Guid userId, CancellationToken ct);

    /// <summary>Points the book at its uploaded cover; the updated book, null when not the user's.</summary>
    Task<Book?> SetCoverAsync(Guid userId, Guid bookId, string coverKey, CancellationToken ct);


    /// <summary>Every key of the user's bytes, files and covers: what an account delete removes from disk (they may sit under another user's directory after a merge).</summary>
    Task<IReadOnlyList<string>> ListStorageKeysAsync(Guid userId, CancellationToken ct);

    /// <summary>Cross-user, for the orphan sweep: every key a file or a cover names.</summary>
    Task<IReadOnlySet<string>> AllStorageKeysAsync(CancellationToken ct);
}

public enum AttachOutcome
{
    /// <summary><see cref="ContentAttachment.File"/> now has content.</summary>
    Attached,

    /// <summary>The current file already has content: nothing changed (a replay).</summary>
    AlreadyStored,

    /// <summary>The file is a superseded version: <see cref="ContentAttachment.File"/> is the current one (null: none).</summary>
    FileReplaced,

    /// <summary><see cref="ContentAttachment.Book"/> is the removed book.</summary>
    BookRemoved,

    /// <summary>The bytes do not fit: <see cref="ContentAttachment.Used"/> is what the user already stores.</summary>
    QuotaExceeded,

    /// <summary>No such book, or the file is not a version of it.</summary>
    NotFound,
}

public sealed record ContentAttachment(AttachOutcome Outcome, BookFile? File = null, Book? Book = null, long Used = 0);

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
    /// <summary>
    /// <see cref="FileReplacement.Current"/> is the new file, <see cref="FileReplacement.Superseded"/> the one it replaced (null: there was none).
    /// The superseded version's key is cleared with it: <see cref="FileReplacement.ReleasedKey"/> names the bytes to delete after the commit.
    /// </summary>
    Replaced,

    /// <summary>The file is already the book's current one: nothing changed.</summary>
    Replayed,

    /// <summary>The caller's view is stale (its <c>replacesFileId</c> is not current, or the file is a superseded version): <see cref="FileReplacement.Current"/> is the book's current file.</summary>
    FileReplaced,

    /// <summary><see cref="FileReplacement.Book"/> is the removed book.</summary>
    BookRemoved,

    NotFound,

    /// <summary>The file id belongs to another book (perhaps another user's).</summary>
    IdConflict,
}

public sealed record FileReplacement(
    FileReplaceOutcome Outcome, BookFile? Current = null, BookFile? Superseded = null, Book? Book = null, string? ReleasedKey = null);
