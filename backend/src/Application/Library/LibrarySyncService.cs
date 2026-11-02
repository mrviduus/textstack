using System.Text.Json;
using Application.Common;
using Application.Reading;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using static Application.Sync.SyncValidation;

namespace Application.Library;

/// <summary>The /me/v2 library use cases: lookup by bytes, import, metadata edit, file replacement, remove/restore, the library feed.</summary>
public sealed class LibrarySyncService(ILibraryRepository library, IReadingStateRepository states, IV2UnitOfWork unitOfWork)
{
    public async Task<SyncResult> FindBySha256Async(Guid userId, string sha256, CancellationToken ct)
    {
        if (Sha256(sha256) is { } invalid) return invalid;
        return await library.FindBySha256Async(userId, sha256, ct) is { } book ? SyncResult.Ok(book.ToDto()) : SyncResult.NotFound();
    }

    public async Task<SyncResult> ImportAsync(Guid userId, Guid bookId, ImportBookRequest r, CancellationToken ct)
    {
        var f = r.File;
        var invalid = Title(r.Title) ?? Tags(r.Tags) ?? Required(f, "file") ?? Required(f!.Id, "file.id")
            ?? File("file.", f.Sha256, f.ByteSize, f.OriginalName, f.Format, f.Toc);
        if (invalid is not null) return invalid;

        var book = new Book
        {
            Id = bookId,
            Title = r.Title!,
            Author = r.Author,
            Language = r.Language,
            Description = r.Description,
            Genre = r.Genre,
            PublishedYear = r.PublishedYear,
            Tags = r.Tags ?? [],
        };
        var result = await library.ImportAsync(userId, book, NewFile(f!.Id!.Value, bookId, f.Sha256, f.ByteSize, f.OriginalName, f.Format, f.PageCount, f.Toc), ct);
        return result.Outcome switch
        {
            ImportOutcome.Created => SyncResult.Created(result.Book!.ToDto()),
            ImportOutcome.Replayed => SyncResult.Ok(result.Book!.ToDto()),
            ImportOutcome.DuplicateFile => SyncResult.Fail(new V2Error(
                SyncCodes.DuplicateFile, "A book with these bytes is already in the library.", Current: result.Book!.ToDto())),
            _ => SyncResult.Fail(new V2Error(SyncCodes.IdConflict, "Mint a new id and retry.")),
        };
    }

    public async Task<SyncResult> UpdateMetadataAsync(Guid userId, Guid bookId, PatchBookRequest r, CancellationToken ct)
    {
        if (Required(r.ExpectedRevision, "expectedRevision") is { } missing) return missing;
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound();
        if (!TryMerge(book, r, out var metadata, out var invalid)) return invalid!;

        var result = await library.UpdateMetadataAsync(userId, bookId, metadata, r.ExpectedRevision!.Value, ct);
        return result.Accepted
            ? SyncResult.Ok(result.Current!.ToDto())
            : SyncResult.Fail(new V2Error(SyncCodes.StaleRevision, "Another device edited this book.", result.Current!.Revision, result.Current.ToDto()));
    }

    // Merge-patch: an absent member keeps the stored value, null clears it (the title cannot be cleared).
    private static bool TryMerge(Book stored, PatchBookRequest r, out BookMetadata metadata, out SyncResult? invalid)
    {
        metadata = null!;
        try
        {
            static string? Text(JsonElement e, string? kept) => e.ValueKind == JsonValueKind.Undefined ? kept : e.Deserialize<string?>();
            var title = Text(r.Title, stored.Title);
            var tags = r.Tags.ValueKind == JsonValueKind.Undefined ? stored.Tags : r.Tags.Deserialize<string[]?>() ?? [];
            int? year = r.PublishedYear.ValueKind == JsonValueKind.Undefined ? stored.PublishedYear : r.PublishedYear.Deserialize<int?>();
            invalid = Title(title) ?? Tags(tags);
            if (invalid is not null) return false;
            metadata = new BookMetadata(title!, Text(r.Author, stored.Author), Text(r.Language, stored.Language),
                Text(r.Description, stored.Description), Text(r.Genre, stored.Genre), year, tags);
            return true;
        }
        catch (JsonException)
        {
            invalid = SyncResult.Invalid("metadata", "A metadata field has the wrong type.");
            return false;
        }
    }

    /// <summary>
    /// The replacement and the reading-state delete commit together (#1067): the state's locators
    /// mean nothing in the new version, and a device still on the old file loses by the file guard.
    /// </summary>
    public async Task<SyncResult> ReplaceFileAsync(Guid userId, Guid bookId, Guid fileId, ReplaceFileRequest r, CancellationToken ct)
    {
        if (File("", r.Sha256, r.ByteSize, r.OriginalName, r.Format, r.Toc) is { } invalid) return invalid;
        var file = NewFile(fileId, bookId, r.Sha256, r.ByteSize, r.OriginalName, r.Format, r.PageCount, r.Toc);

        await using var tx = await unitOfWork.BeginAsync(ct);
        var result = await library.ReplaceFileAsync(userId, bookId, file, r.ReplacesFileId, tx.Transaction, ct);
        if (result.Outcome == FileReplaceOutcome.Replaced && result.Superseded is { } old)
            await states.DeleteForFileAsync(userId, bookId, old.Id, tx.Transaction, ct);
        await tx.CommitAsync(ct);

        return result.Outcome switch
        {
            FileReplaceOutcome.Replaced or FileReplaceOutcome.Replayed =>
                SyncResult.Ok(new FileReplacementDto(result.Current!.ToDto(), result.Superseded?.ToDto())),
            FileReplaceOutcome.FileReplaced => SyncResult.Fail(new V2Error(
                SyncCodes.FileReplaced, "This book's file was replaced.", FileId: result.Current?.Id, CurrentFile: result.Current?.ToDto())),
            FileReplaceOutcome.BookRemoved => SyncResult.Fail(new V2Error(
                SyncCodes.BookRemoved, "Restore the book first.", Current: (await library.GetAsync(userId, bookId, ct))?.ToDto())),
            FileReplaceOutcome.IdConflict => SyncResult.Fail(new V2Error(SyncCodes.IdConflict, "Mint a new id and retry.")),
            _ => SyncResult.BookNotFound(),
        };
    }

    /// <summary>Idempotent: removing a removed book (or restoring a live one) is 204 too.</summary>
    public async Task<SyncResult> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        await library.RemoveAsync(userId, bookId, ct) || await library.GetAsync(userId, bookId, ct) is not null
            ? SyncResult.NoContent : SyncResult.BookNotFound();

    public async Task<SyncResult> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        await library.RestoreAsync(userId, bookId, ct) || await library.GetAsync(userId, bookId, ct) is not null
            ? SyncResult.NoContent : SyncResult.BookNotFound();

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, int? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => library.ListChangedAsync(userId, since, after, take, ct),
            b => (b.UpdatedAt, b.Id), b => b.ToDto());

    private static BookFile NewFile(Guid id, Guid bookId, string? sha256, long? byteSize, string? originalName, string? format, int? pageCount, JsonElement? toc) => new()
    {
        Id = id,
        BookId = bookId,
        Sha256 = sha256!,
        ByteSize = byteSize!.Value,
        OriginalName = originalName!,
        Format = format!,
        PageCount = pageCount,
        Toc = toc?.GetRawText(),
    };
}
