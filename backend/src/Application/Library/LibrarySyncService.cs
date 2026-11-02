using System.Text.Json;
using Application.Common;
using Application.Reading;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using static Application.Sync.SyncValidation;

namespace Application.Library;

/// <summary>The /me/v2 library use cases: lookup by bytes, import, metadata edit, file replacement, remove/restore, the library feed.</summary>
public sealed class LibrarySyncService(ILibraryRepository library, IReadingStateRepository states, IV2UnitOfWork unitOfWork, ILibraryFileStore files)
{
    public async Task<SyncResult> FindBySha256Async(Guid userId, string sha256, CancellationToken ct)
    {
        if (Sha256(sha256) is { } invalid) return invalid;
        return await library.FindBySha256Async(userId, sha256, ct) is { } book ? SyncResult.Ok(book.ToDto()) : SyncResult.NotFound;
    }

    public async Task<SyncResult> ImportAsync(Guid userId, Guid bookId, ImportBookRequest r, CancellationToken ct)
    {
        var metadata = new BookMetadata(r.Title!, r.Author, r.Language, r.Description, r.Genre, r.PublishedYear, r.Tags ?? []);
        var invalid = ClientId(bookId, "bookId") ?? Metadata(metadata) ?? File("file.", r.File) ?? ClientId(r.File!.Id, "file.id");
        if (invalid is not null) return invalid;

        var book = new Book
        {
            Id = bookId,
            Title = metadata.Title,
            Author = metadata.Author,
            Language = metadata.Language,
            Description = metadata.Description,
            Genre = metadata.Genre,
            PublishedYear = metadata.PublishedYear,
            Tags = metadata.Tags,
        };
        var result = await library.ImportAsync(userId, book, NewFile(r.File.Id!.Value, bookId, r.File), ct);
        return result.Outcome switch
        {
            ImportOutcome.Created => SyncResult.Created(result.Book!.ToDto()),
            ImportOutcome.Replayed => SyncResult.Ok(result.Book!.ToDto()),
            ImportOutcome.DuplicateFile => SyncResult.DuplicateFile(result.Book!),
            _ => SyncResult.IdConflict,
        };
    }

    public async Task<SyncResult> UpdateMetadataAsync(Guid userId, Guid bookId, PatchBookRequest r, CancellationToken ct)
    {
        if (Required(r.ExpectedRevision, "expectedRevision") is { } missing) return missing;
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        if (book.RemovedAt is not null) return SyncResult.BookRemoved(book);
        if (!TryMerge(book, r, out var metadata, out var invalid)) return invalid!;

        var result = await library.UpdateMetadataAsync(userId, bookId, metadata, r.ExpectedRevision!.Value, ct);
        return result switch
        {
            { Accepted: true } => SyncResult.Ok(result.Current!.ToDto()),
            // The book went between the read and the update (an account delete).
            { Current: null } => SyncResult.BookNotFound,
            // Removed in between: the update's guard refused it.
            { Current.RemovedAt: not null } => SyncResult.BookRemoved(result.Current),
            _ => SyncResult.StaleRevision(result.Current.Revision, result.Current.ToDto()),
        };
    }

    // Merge-patch: an absent member keeps the stored value, null clears it (the title cannot be cleared).
    private static bool TryMerge(Book stored, PatchBookRequest r, out BookMetadata metadata, out SyncResult? invalid)
    {
        metadata = null!;
        try
        {
            static string? Merged(JsonElement e, string? kept) => e.ValueKind == JsonValueKind.Undefined ? kept : e.Deserialize<string?>();
            var tags = r.Tags.ValueKind == JsonValueKind.Undefined ? stored.Tags : r.Tags.Deserialize<string[]?>() ?? [];
            int? year = r.PublishedYear.ValueKind == JsonValueKind.Undefined ? stored.PublishedYear : r.PublishedYear.Deserialize<int?>();
            metadata = new BookMetadata(Merged(r.Title, stored.Title)!, Merged(r.Author, stored.Author), Merged(r.Language, stored.Language),
                Merged(r.Description, stored.Description), Merged(r.Genre, stored.Genre), year, tags);
            invalid = Metadata(metadata);
            return invalid is null;
        }
        // A wrong type, or an escaped lone surrogate a string cannot even be read from.
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            invalid = SyncResult.Invalid("metadata", "A metadata field has the wrong type or unstorable text.");
            return false;
        }
    }

    /// <summary>
    /// The replacement and the reading-state delete commit together (#1067): the state's locators
    /// mean nothing in the new version, and a device still on the old file loses by the file guard.
    /// The old version's bytes go after the commit, best-effort: a failure leaves bytes no row names,
    /// which the worker's orphan sweep deletes.
    /// </summary>
    public async Task<SyncResult> ReplaceFileAsync(Guid userId, Guid bookId, Guid fileId, ReplaceFileRequest r, CancellationToken ct)
    {
        if (File("file.", r.File) is { } invalid) return invalid;

        await using var tx = await unitOfWork.BeginAsync(ct);
        var result = await library.ReplaceFileAsync(userId, bookId, NewFile(fileId, bookId, r.File!), r.ReplacesFileId, tx.Transaction, ct);
        if (result.Outcome == FileReplaceOutcome.Replaced && result.Superseded is { } old)
            await states.DeleteForFileAsync(userId, bookId, old.Id, tx.Transaction, ct);
        await tx.CommitAsync(ct);
        if (result.ReleasedKey is { } released) files.TryDelete(released);

        return result.Outcome switch
        {
            FileReplaceOutcome.Replaced or FileReplaceOutcome.Replayed =>
                SyncResult.Ok(new FileReplacementDto(result.Current!.ToDto(), result.Superseded?.ToDto())),
            FileReplaceOutcome.FileReplaced => SyncResult.FileReplaced(result.Current),
            FileReplaceOutcome.BookRemoved => SyncResult.BookRemoved(result.Book!),
            FileReplaceOutcome.IdConflict => SyncResult.IdConflict,
            _ => SyncResult.BookNotFound,
        };
    }

    /// <summary>Idempotent: removing a removed book is 204 too.</summary>
    public async Task<SyncResult> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        await IdempotentAsync(await library.RemoveAsync(userId, bookId, ct), userId, bookId, ct);

    /// <summary>Idempotent: restoring a live book is 204 too.</summary>
    public async Task<SyncResult> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        await IdempotentAsync(await library.RestoreAsync(userId, bookId, ct), userId, bookId, ct);

    private async Task<SyncResult> IdempotentAsync(bool changed, Guid userId, Guid bookId, CancellationToken ct) =>
        changed || await library.ExistsAsync(userId, bookId, ct) ? SyncResult.NoContent : SyncResult.BookNotFound;

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, string? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => library.ListChangedAsync(userId, since, after, take, ct),
            b => (b.UpdatedAt, b.Id), b => b.ToDto());

    private static BookFile NewFile(Guid id, Guid bookId, BookFileRequest f) => new()
    {
        Id = id,
        BookId = bookId,
        Sha256 = f.Sha256!,
        ByteSize = f.ByteSize!.Value,
        OriginalName = f.OriginalName!,
        Format = f.Format!,
        PageCount = f.PageCount,
        Toc = f.Toc,
    };
}
