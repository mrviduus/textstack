using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using static Application.Sync.SyncValidation;

namespace Application.Library;

/// <summary>
/// A web page clipped by the browser extension (<c>POST /me/books/clip</c>) as a V2 book (M5.1 Part C): one
/// <c>html</c> file (server-only, <see cref="SyncValidation.File"/>), its origin <c>{kind: clip, sourceUrl}</c> as the
/// ETL writes legacy's clips. The bytes go through the same part + complete as a client upload, so the quota and
/// the file store are the V2 ones. Its chapters are extracted (the html extractor) for the assistant tools; the V2
/// reader reads the page itself.
/// </summary>
public sealed class ClipService(ILibraryRepository library, LibraryContentService content)
{
    /// <summary>The new book (or the one already holding this page) on success; the refusal otherwise.</summary>
    public async Task<(Guid? BookId, SyncResult? Refused)> ClipAsync(
        Guid userId, string title, string? author, string? language, string? sourceUrl, string html, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(html);
        var metadata = new BookMetadata(title.Trim(), author, language, null, null, null, []);
        if (Metadata(metadata) is { } invalid) return (null, invalid);

        var (bookId, fileId) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        var imported = await library.ImportAsync(userId, new Book
        {
            Id = bookId,
            Title = metadata.Title,
            Author = metadata.Author,
            Language = metadata.Language,
            Origin = JsonSerializer.Serialize(sourceUrl is null ? new { kind = "clip" } : (object)new { kind = "clip", sourceUrl }),
        }, new BookFile
        {
            Id = fileId,
            BookId = bookId,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            ByteSize = bytes.Length,
            OriginalName = "original.html",
            Format = "html",
        }, ct);
        var created = imported.Outcome == ImportOutcome.Created;
        if (!created && imported.Outcome != ImportOutcome.DuplicateFile) return (null, SyncResult.IdConflict);
        // The same page clipped again is the book that already holds it (a client import's duplicate_file). If an
        // earlier attempt stopped before its bytes landed, this one stores them.
        if (!created)
        {
            var held = imported.Book!;
            if (held.CurrentFile is not { ServerStorageKey: null } empty || empty.Sha256 != Convert.ToHexStringLower(SHA256.HashData(bytes)))
                return (held.Id, null);
            (bookId, fileId) = (held.Id, empty.Id);
        }

        var done = await UploadAsync(userId, bookId, fileId, bytes, ct);
        if (done.Status == 200) return (bookId, null);

        // ponytail: a new clip refused (over quota) leaves its empty book in the trash; check the quota before the
        // import if that clutter ever shows. A book that was there before stays as it was.
        if (created) await library.RemoveAsync(userId, bookId, ct);
        return (null, done);
    }

    /// <summary>The page as the file's one part, then complete: the V2 quota and file store, extraction queued.</summary>
    private async Task<SyncResult> UploadAsync(Guid userId, Guid bookId, Guid fileId, byte[] bytes, CancellationToken ct)
    {
        using var body = new MemoryStream(bytes);
        var part = await content.SavePartAsync(userId, bookId, fileId, 0, bytes.Length, body, bytes.Length, ct);
        return part.Status == 200 ? await content.CompleteAsync(userId, bookId, fileId, new CompleteContentRequest(1), ct) : part;
    }
}
