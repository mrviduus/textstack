using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Common;
using Application.Sync;
using Contracts.Sync;
using Domain.Library;
using Npgsql;
using static Application.Sync.SyncValidation;

namespace Application.Library;

/// <summary>
/// A web page clipped by the browser extension (<c>POST /me/books/clip</c>) as a V2 book (M5.1 Part C): one
/// <c>html</c> file (server-only, <see cref="SyncValidation.File"/>), its origin <c>{kind: clip, sourceUrl}</c> as the
/// ETL writes legacy's clips. The bytes go through the same part + complete as a client upload, so the quota and
/// the file store are the V2 ones. Its chapters are extracted (the html extractor) for the assistant tools; the V2
/// reader reads the page itself.
/// </summary>
public sealed class ClipService(ILibraryRepository library, LibraryContentService content, IUnitOfWork unitOfWork)
{
    /// <summary>
    /// The new book (or the one already holding this page) on success; the refusal otherwise. Clips of the same page by
    /// the same user run one at a time (a transaction advisory lock on user + sha256): a concurrent duplicate waits and
    /// then finds the first one's book, instead of racing its upload.
    /// </summary>
    public async Task<(Guid? BookId, SyncResult? Refused)> ClipAsync(
        Guid userId, string title, string? author, string? language, string? sourceUrl, string html, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(html);
        var metadata = new BookMetadata(title.Trim(), author, language, null, null, null, []);
        if (Metadata(metadata) is { } invalid) return (null, invalid);
        var sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));

        await using var tx = await unitOfWork.BeginAsync(ct);
        await using (var lockPage = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@key, 0))", tx.Connection, tx.Transaction))
        {
            lockPage.Parameters.AddWithValue("key", $"clip:{userId:N}:{sha256}");
            await lockPage.ExecuteNonQueryAsync(ct);
        }
        var result = await ClipLockedAsync(userId, metadata, sourceUrl, bytes, sha256, ct);
        await tx.Transaction.CommitAsync(ct);
        return result;
    }

    private async Task<(Guid? BookId, SyncResult? Refused)> ClipLockedAsync(
        Guid userId, BookMetadata metadata, string? sourceUrl, byte[] bytes, string sha256, CancellationToken ct)
    {
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
            Sha256 = sha256,
            ByteSize = bytes.Length,
            OriginalName = "original.html",
            Format = "html",
        }, ct);
        var created = imported.Outcome == ImportOutcome.Created;
        if (!created && imported.Outcome != ImportOutcome.DuplicateFile) return (null, SyncResult.IdConflict);
        // The same page clipped again is the book that already holds it (a client import's duplicate_file). If an
        // earlier attempt stopped before its bytes landed, this one stores them; bytes the reader removed stay removed.
        if (!created)
        {
            var held = imported.Book!;
            if (held.CurrentFile is not { ServerStorageKey: null, ContentRemovedAt: null } empty || empty.Sha256 != sha256)
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

    /// <summary>The page as the file's one part, then complete: the V2 quota and file store.</summary>
    private async Task<SyncResult> UploadAsync(Guid userId, Guid bookId, Guid fileId, byte[] bytes, CancellationToken ct)
    {
        using var body = new MemoryStream(bytes);
        var part = await content.SavePartAsync(userId, bookId, fileId, 0, bytes.Length, body, bytes.Length, ct);
        return part.Status == 200 ? await content.CompleteAsync(userId, bookId, fileId, new CompleteContentRequest(1), ct) : part;
    }
}
