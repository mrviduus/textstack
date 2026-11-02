using Application.Sync;

namespace Application.Library;

/// <summary>
/// The provenance pre-check of every V2 write naming a book and, optionally, one of its file versions
/// (PDD "Deferred provenance FKs", M1.3 delta 8): the schema would refuse a bad one only at commit, as a
/// 500 an outbox retries forever. A removed book counts (owner decision 11); any version of it, current or not.
/// </summary>
public static class LibraryProvenance
{
    /// <summary>Null when the book is the user's and <paramref name="fileId"/>, if given, a version of it; else <c>book_not_found</c> or <c>unknown_file</c>.</summary>
    public static async Task<SyncResult?> MissingBookOrFileAsync(
        this ILibraryRepository library, Guid userId, Guid bookId, Guid? fileId, CancellationToken ct)
    {
        // A file row proves its book, so the happy path is one round trip; the book is asked only to pick the code.
        if (fileId is { } id && await library.GetFileAsync(userId, bookId, id, ct) is not null) return null;
        if (!await library.ExistsAsync(userId, bookId, ct)) return SyncResult.BookNotFound;
        return fileId is null ? null : SyncResult.UnknownFile;
    }
}
