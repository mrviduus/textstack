using System.Buffers;
using Application.Entitlements;
using Application.Identity;
using Application.Sync;
using Application.Transitional;
using Contracts.V2;
using Domain.Enums;
using Domain.Library;
using Microsoft.Extensions.Logging;
using static Contracts.V2.SyncLimits;

namespace Application.Library;

/// <summary>
/// The /me/v2 bytes use cases (M2.6, PDD "File sync upload protocol"): parts, complete, download,
/// "stop syncing this file", the cover. Bytes attach only to a book's current file. The quota is the
/// bytes the server holds over V2 <c>book_files</c> against legacy's tier limits (owner decision 2):
/// a part checks it cheaply before a byte lands; the complete decides, inside the attach's transaction.
/// </summary>
public sealed class LibraryContentService(
    ILibraryRepository library, IIngestionJobRepository jobs, IUserRepository users, ILibraryFileStore files,
    EntitlementOptions entitlements, ILogger<LibraryContentService> logger)
{
    private readonly EntitlementResolver _resolver = new(entitlements);

    /// <summary>
    /// One part, at most <paramref name="maxPartBytes"/>, its <paramref name="declaredLength"/> checked
    /// before a byte is stored. Advisory quota: the stored bytes plus this file's size (the complete decides).
    /// Parts are not summed against the file's size: stray parts of an earlier chunking must not block a
    /// new one, and the complete checks size and sha256 anyway. Parts are bounded by MaxParts and swept daily.
    /// ponytail: a part for a file that already has content is accepted and swept later; refuse it if
    /// disk use from such retries ever shows up.
    /// </summary>
    public async Task<SyncResult> SavePartAsync(
        Guid userId, Guid bookId, Guid fileId, int index, long declaredLength, Stream body, long maxPartBytes, CancellationToken ct)
    {
        if (index is < 0 or >= MaxParts) return SyncResult.Invalid("index", $"index is 0 to {MaxParts - 1}.");
        if (declaredLength is <= 0 || declaredLength > maxPartBytes)
            return SyncResult.Invalid("part", $"A part is 1 to {maxPartBytes} bytes.");
        var (missing, book, file) = await TargetAsync(userId, bookId, fileId, ct);
        if ((missing ?? NotUploadable(book!, file!)) is { } refused) return refused;

        var used = await library.StoredBytesAsync(userId, ct);
        var limit = await LimitAsync(userId, ct);
        if (used + file!.ByteSize > limit) return QuotaExceeded(used, limit);

        var size = await files.SavePartAsync(userId, fileId, index, body, declaredLength, ct);
        return size is { } stored ? SyncResult.Ok(new UploadedPartDto(index, stored)) : SyncResult.Invalid("part", "The part is empty or longer than its Content-Length.");
    }

    /// <summary>Joins the parts, checks them against the file version, and attaches them under the quota.</summary>
    public async Task<SyncResult> CompleteAsync(Guid userId, Guid bookId, Guid fileId, CompleteContentRequest r, CancellationToken ct)
    {
        if (r.PartCount is not (>= 1 and <= MaxParts)) return SyncResult.Invalid("partCount", $"partCount is 1 to {MaxParts}.");
        var (missing, book, file) = await TargetAsync(userId, bookId, fileId, ct);
        if (missing is not null) return missing;
        // A replay first: the complete it repeats landed, so it answers 200 even after a removal.
        if (file!.IsCurrent && file.ServerStorageKey is not null) return await ReplayAsync(file, ct);
        if (NotUploadable(book!, file) is { } refused) return refused;

        var limit = await LimitAsync(userId, ct);
        var staged = await files.AssembleAsync(userId, fileId, r.PartCount.Value, files.FileKey(userId, bookId, fileId, file.Format), ct);
        if (staged is null)
        {
            // A concurrent complete of the same file may have taken the parts: its outcome is this one's.
            var now = await library.GetFileAsync(userId, bookId, fileId, ct);
            return now is { IsCurrent: true, ServerStorageKey: not null } ? SyncResult.Ok(now.ToDto()) : SyncResult.Fail(SyncCodes.IncompleteUpload);
        }
        try
        {
            if (staged.Sha256 != file.Sha256 || staged.ByteSize != file.ByteSize)
            {
                files.DeleteParts(userId, fileId);
                return SyncResult.Fail(SyncCodes.ContentMismatch, current: new ContentMismatchDto(file.Sha256, staged.Sha256!, staged.ByteSize));
            }
            var attach = await library.AttachContentAsync(userId, bookId, fileId, staged.Key, limit, () => files.Place(staged), ct);
            // Stored, refused for good, or a superseded version (never uploadable again): the parts are done.
            // Removed (a restore may follow) or gone while they were joined: they stay.
            if (attach.Outcome is not (AttachOutcome.BookRemoved or AttachOutcome.NotFound))
                files.DeleteParts(userId, fileId);
            if (attach.Outcome == AttachOutcome.Attached) await EnqueueExtractionAsync(attach.File!, ct);
            return attach.Outcome switch
            {
                AttachOutcome.Attached or AttachOutcome.AlreadyStored => SyncResult.Ok(attach.File!.ToDto()),
                AttachOutcome.QuotaExceeded => QuotaExceeded(attach.Used, limit),
                AttachOutcome.FileReplaced => SyncResult.FileReplaced(attach.File),
                AttachOutcome.BookRemoved => SyncResult.BookRemoved(attach.Book!),
                _ => SyncResult.BookNotFound,
            };
        }
        finally
        {
            files.Discard(staged);
        }
    }

    // The enqueue runs after the attach commits; if it failed, the client's retry lands here and makes up for it.
    private async Task<SyncResult> ReplayAsync(BookFile file, CancellationToken ct)
    {
        files.DeleteParts(file.UserId, file.Id);
        if (await jobs.GetLatestForFileAsync(file.UserId, file.BookId, file.Id, ct) is null) await EnqueueExtractionAsync(file, ct);
        return SyncResult.Ok(file.ToDto());
    }

    // Transitional (dropped at M6.4): the server extracts chapters for the readers that still need them.
    private async Task EnqueueExtractionAsync(BookFile file, CancellationToken ct)
    {
        if (file.Format is "epub" or "pdf") await jobs.EnqueueAsync(file.UserId, file.BookId, file.Id, ct);
    }

    /// <summary>The bytes of any version, with range support; <c>no_content</c> when the server holds none.</summary>
    public async Task<SyncResult> ReadAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        var file = await library.GetFileAsync(userId, bookId, fileId, ct);
        if (file is null) return (await library.MissingBookOrFileAsync(userId, bookId, fileId, ct))!;
        if (file.ServerStorageKey is not { } key) return SyncResult.Fail(SyncCodes.NoContent);
        if (files.Locate(key) is not { } path)
        {
            logger.LogWarning("V2 file {FileId} of user {UserId} has storage key {StorageKey} but no bytes on disk", fileId, userId, key);
            return SyncResult.Fail(SyncCodes.NoContent);
        }
        // A reader's book: no shared cache may keep it (the owner check lives in the API only).
        return SyncResult.Bytes(new StoredBytes(path, ContentTypeOf(file.Format), CacheControl: "private, no-store"));
    }

    /// <summary>
    /// "Stop syncing this file": the row says so first, then the bytes it named go (a failed delete leaves
    /// them to the orphan sweep); idempotent, any version.
    /// </summary>
    public async Task<SyncResult> RemoveAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        if (await library.RemoveContentAsync(userId, bookId, fileId, ct) is { } cleared)
        {
            if (!files.TryDelete(cleared)) logger.LogWarning("Could not delete {StorageKey} of file {FileId}; the orphan sweep will", cleared, fileId);
            return SyncResult.NoContent;
        }
        // Nothing cleared: already stopped or nothing stored (204), or not a version of the user's book.
        return await library.MissingBookOrFileAsync(userId, bookId, fileId, ct) ?? SyncResult.NoContent;
    }

    /// <summary>A client-extracted cover: size and format checked by its first bytes, never parsed (owner decision 4).</summary>
    public async Task<SyncResult> PutCoverAsync(Guid userId, Guid bookId, string? contentType, long? contentLength, Stream body, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        if (book.RemovedAt is not null) return SyncResult.BookRemoved(book);
        var tooBig = SyncResult.Invalid("cover", $"A cover is 1 byte to {MaxCoverBytes / 1024 / 1024} MB.");
        if (contentLength > MaxCoverBytes) return tooBig;

        // One byte over the cap tells an oversized body sent without a Content-Length.
        var buffer = ArrayPool<byte>.Shared.Rent(MaxCoverBytes + 1);
        try
        {
            var length = await body.ReadAtLeastAsync(buffer.AsMemory(0, MaxCoverBytes + 1), MaxCoverBytes + 1, throwOnEndOfStream: false, ct);
            if (length is 0 or > MaxCoverBytes) return tooBig;
            if (CoverExtension(contentType, buffer.AsSpan(0, length)) is not { } extension)
                return SyncResult.Invalid("cover", "A cover is a JPEG, PNG or WebP image sent with its own Content-Type.");

            // Staged, then the row, then into place: a book deleted meanwhile leaves no cover behind.
            var staged = await files.StageAsync(files.CoverKey(userId, bookId, extension), buffer.AsMemory(0, length), ct);
            try
            {
                var updated = await library.SetCoverAsync(userId, bookId, staged.Key, ct);
                if (updated is null) return SyncResult.BookNotFound;
                files.Place(staged);
                if (book.CoverKey is { } old && old != staged.Key && !files.TryDelete(old))
                    logger.LogWarning("Could not delete the replaced cover {StorageKey}; the orphan sweep will", old);
                return SyncResult.Ok(updated.ToDto());
            }
            finally
            {
                files.Discard(staged);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    /// <summary>The cover, cached long: the URL stays, so a client that saw the book change asks with <c>?v={updatedAt}</c>; the ETag answers the rest.</summary>
    public async Task<SyncResult> GetCoverAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        if (book.CoverKey is not { } key) return SyncResult.NotFound;
        var type = CoverTypes.FirstOrDefault(t => key.EndsWith("." + t.Extension, StringComparison.Ordinal));
        if (type.ContentType is null || files.Locate(key) is not { } path)
        {
            logger.LogWarning("V2 book {BookId} of user {UserId} names cover {CoverKey}, which is not a stored cover", bookId, userId, key);
            return SyncResult.NotFound;
        }
        return SyncResult.Bytes(new StoredBytes(path, type.ContentType, $"\"{book.UpdatedAt.UtcTicks}\"", "private, max-age=31536000"));
    }

    private static readonly (string ContentType, string Extension, byte[] Magic)[] CoverTypes =
    [
        ("image/jpeg", "jpg", [0xFF, 0xD8, 0xFF]),
        ("image/png", "png", [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        ("image/webp", "webp", "RIFF"u8.ToArray()),
    ];

    /// <summary>The extension of a cover whose first bytes are what its Content-Type says; null otherwise.</summary>
    public static string? CoverExtension(string? contentType, ReadOnlySpan<byte> bytes)
    {
        var mediaType = contentType?.Split(';')[0].Trim();
        foreach (var (type, extension, magic) in CoverTypes)
            if (string.Equals(type, mediaType, StringComparison.OrdinalIgnoreCase) && bytes.StartsWith(magic)
                && (extension != "webp" || bytes.Length >= 12 && bytes[8..12].SequenceEqual("WEBP"u8)))
                return extension;
        return null;
    }

    private static string ContentTypeOf(string format) => format switch
    {
        "epub" => "application/epub+zip",
        "pdf" => "application/pdf",
        _ => "text/html",
    };

    /// <summary>The book and the version a bytes write names; a refusal when either is not the user's.</summary>
    private async Task<(SyncResult? Missing, Book? Book, BookFile? File)> TargetAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return (SyncResult.BookNotFound, null, null);
        // Uploads name the current file: the book read already carries it.
        var file = book.CurrentFile?.Id == fileId ? book.CurrentFile : await library.GetFileAsync(userId, bookId, fileId, ct);
        return file is null ? (SyncResult.UnknownFile, null, null) : (null, book, file);
    }

    // Bytes attach only to the current file of a live book (PDD, M1.2 delta 4).
    private static SyncResult? NotUploadable(Book book, BookFile file) =>
        book.RemovedAt is not null ? SyncResult.BookRemoved(book)
        : !file.IsCurrent ? SyncResult.FileReplaced(book.CurrentFile)
        : null;

    private static SyncResult QuotaExceeded(long used, long limit) => SyncResult.Fail(SyncCodes.QuotaExceeded, current: new StorageQuotaDto(used, limit));

    // Legacy's tiers over the V2 user row (V2Gate made sure it exists).
    private async Task<long> LimitAsync(Guid userId, CancellationToken ct)
    {
        var user = await users.GetAsync(userId, ct);
        var tier = Enum.TryParse<UserTier>(user?.Tier, out var t) ? t : UserTier.Free;
        return _resolver.Resolve(tier, user?.IsGuest ?? false, user?.Email, user?.StorageLimitOverrideBytes).StorageLimitBytes;
    }
}
