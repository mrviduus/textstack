namespace Application.Library;

/// <summary>
/// The bytes of V2 library files and covers on the persistent volume (plan §4.5, <c>Storage:LibraryRoot</c>),
/// and the upload parts on their way there (PDD "File sync upload protocol"). Not legacy's
/// <c>IFileStorageService</c>/<c>ChunkedUploadStore</c>: those are a temp dir and legacy's quota (ADR-030).
/// Keys are relative to the root and built only from ids and a server-side format, never from client
/// text, so no key can leave the root. A file id is its upload's id: no init call, no row.
/// </summary>
public interface ILibraryFileStore
{
    /// <summary><c>library/{u[..2]}/{u}/{bookId}/{fileId}.{format}</c>; <paramref name="format"/> is the stored <c>book_files.format</c>.</summary>
    string FileKey(Guid userId, Guid bookId, Guid fileId, string format);

    /// <summary><c>library/{u[..2]}/{u}/{bookId}/cover.{extension}</c>.</summary>
    string CoverKey(Guid userId, Guid bookId, string extension);

    /// <summary>
    /// Stores one part, replacing an earlier attempt at the same index. Reads at most <paramref name="maxBytes"/>;
    /// null (nothing kept) when the body was empty or longer. Nothing partial is kept on an abort either.
    /// </summary>
    Task<long?> SavePartAsync(Guid userId, Guid fileId, int index, Stream body, long maxBytes, CancellationToken ct);

    /// <summary>
    /// Joins parts <c>0..partCount-1</c> into a temp file next to <paramref name="key"/>'s place, hashing as it
    /// streams. Null when a part is missing (the parts stay for a retry). The parts are not touched.
    /// </summary>
    Task<StagedContent?> AssembleAsync(Guid userId, Guid fileId, int partCount, string key, CancellationToken ct);

    /// <summary>Moves the staged file to its key (an atomic rename on the same volume).</summary>
    void Place(StagedContent staged);

    /// <summary>Deletes the staged temp file if it is still there. Never throws.</summary>
    void Discard(StagedContent staged);

    void DeleteParts(Guid userId, Guid fileId);

    /// <summary>Deletes every upload untouched for a day, all users (the worker's sweep). Never throws.</summary>
    void SweepStaleParts(DateTimeOffset now);

    /// <summary>The keys of every file under <c>library/</c> last written before <paramref name="cutoff"/>, temp files included, read lazily: the orphan sweep's candidates.</summary>
    IEnumerable<string> EnumerateLibraryFilesOlderThan(DateTimeOffset cutoff);

    /// <summary>Removes empty directories under <c>library/</c> and <c>uploads/</c> last written before <paramref name="olderThan"/>. Never throws.</summary>
    void RemoveEmptyDirectories(DateTimeOffset olderThan);

    /// <summary>The absolute path of <paramref name="key"/>'s bytes; null when they are not on disk.</summary>
    string? Locate(string key);

    /// <summary>Writes <paramref name="bytes"/> to a temp file beside <paramref name="key"/>'s place; <see cref="Place"/> or <see cref="Discard"/> it.</summary>
    Task<StagedContent> StageAsync(string key, ReadOnlyMemory<byte> bytes, CancellationToken ct);

    /// <summary>Deletes <paramref name="key"/>'s bytes. Never throws: false when they could not be deleted (nothing there counts as deleted).</summary>
    bool TryDelete(string key);

    /// <summary>Deletes everything of a deleted account: its library and its parts. Never throws.</summary>
    void DeleteUser(Guid userId);
}

/// <summary>Bytes in a temp file, not yet in place, and how long they are; <see cref="Sha256"/> only for joined parts (a complete checks it).</summary>
public sealed record StagedContent(string Key, string TempPath, string? Sha256, long ByteSize);
