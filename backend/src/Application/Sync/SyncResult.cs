using Contracts.V2;
using Domain.Library;

namespace Application.Sync;

/// <summary>
/// What a V2 use case answers: an HTTP status and its body (a DTO, a <see cref="V2Error"/>, or none).
/// The endpoint writes it as is; the status of a failure follows from its code (<see cref="SyncCodes.StatusOf"/>).
/// </summary>
public sealed record SyncResult(int Status, object? Body)
{
    public static SyncResult Ok(object body) => new(200, body);
    public static SyncResult Created(object body) => new(201, body);

    /// <summary>201 for a write that created the row, 200 for one that found it (a replay, an existing row).</summary>
    public static SyncResult Written(bool created, object body) => created ? Created(body) : Ok(body);

    /// <summary>The write lost to a tombstone: <paramref name="current"/> is it.</summary>
    public static SyncResult Deleted(long revision, object current) => Fail(SyncCodes.Deleted, revision, current);
    public static readonly SyncResult NoContent = new(204, null);

    public static SyncResult Fail(string code, long? revision = null, object? current = null, Guid? fileId = null, BookFileDto? currentFile = null) =>
        new(SyncCodes.StatusOf(code), new V2Error(code, SyncCodes.MessageOf(code), revision, current, fileId, currentFile));

    /// <summary>The one failure whose message is the field's own.</summary>
    public static SyncResult Invalid(string field, string message) =>
        new(SyncCodes.StatusOf(SyncCodes.InvalidPayload), new V2Error(SyncCodes.InvalidPayload, message, Field: field));

    public static readonly SyncResult BookNotFound = Fail(SyncCodes.BookNotFound);
    public static readonly SyncResult NotFound = Fail(SyncCodes.NotFound);
    public static readonly SyncResult IdConflict = Fail(SyncCodes.IdConflict);
    public static readonly SyncResult UnknownFile = Fail(SyncCodes.UnknownFile);
    public static readonly SyncResult V2Unavailable = Fail(SyncCodes.V2Unavailable);

    public static SyncResult BookRemoved(Book book) => Fail(SyncCodes.BookRemoved, book.Revision, book.ToDto());
    public static SyncResult DuplicateFile(Book book) => Fail(SyncCodes.DuplicateFile, book.Revision, book.ToDto());

    /// <summary>The write lost to <paramref name="current"/> (null: nothing stored, or not the caller's).</summary>
    public static SyncResult StaleRevision(long? revision, object? current, BookFile? bookFile = null) =>
        Fail(SyncCodes.StaleRevision, revision, current, bookFile?.Id, bookFile?.ToDto());

    public static SyncResult FileReplaced(BookFile? currentFile, long? revision = null, object? current = null) =>
        Fail(SyncCodes.FileReplaced, revision, current, currentFile?.Id, currentFile?.ToDto());
}

/// <summary>
/// Every code of v2-sync-protocol.md "Conflict codes", with its status and its one message. Some are
/// answered first by later slices (shares, checkpoints, file bytes); they are here so the table is
/// the PDD's, whole.
/// </summary>
public static class SyncCodes
{
    public const string StaleRevision = "stale_revision";
    public const string Reset = "reset";
    public const string FileReplaced = "file_replaced";
    public const string UnknownFile = "unknown_file";
    public const string Deleted = "deleted";
    public const string OperationConflict = "operation_conflict";
    public const string DuplicateFile = "duplicate_file";
    public const string BookRemoved = "book_removed";
    public const string IdConflict = "id_conflict";
    public const string ShareMismatch = "share_mismatch";
    public const string ContentMismatch = "content_mismatch";
    public const string IncompleteUpload = "incomplete_upload";
    public const string BookNotFound = "book_not_found";
    public const string NotFound = "not_found";
    public const string NoContent = "no_content";
    public const string InvalidPayload = "invalid_payload";
    public const string V2Unavailable = "v2_unavailable";

    public static int StatusOf(string code) => Table(code).Status;

    public static string MessageOf(string code) => Table(code).Message;

    private static (int Status, string Message) Table(string code) => code switch
    {
        StaleRevision => (409, "Another device saved a newer version."),
        Reset => (409, "The book was restarted on another device."),
        FileReplaced => (409, "This book's file was replaced."),
        UnknownFile => (409, "Push the file version first."),
        Deleted => (409, "This item was deleted."),
        OperationConflict => (409, "This operation id was used with a different payload."),
        DuplicateFile => (409, "A book with these bytes is already in the library."),
        BookRemoved => (409, "Restore the book first."),
        IdConflict => (409, "Mint a new id and retry."),
        ShareMismatch => (422, "The share is of another chapter or file version."),
        ContentMismatch => (422, "The bytes do not match the file version."),
        IncompleteUpload => (400, "A part is missing: send every part again."),
        BookNotFound => (404, "Push the book first."),
        NotFound => (404, "The server has no such item."),
        NoContent => (404, "The server holds no bytes for this file."),
        InvalidPayload => (400, "The request does not match the protocol."),
        V2Unavailable => (503, "Sync is paused; reading is unaffected."),
        _ => throw new ArgumentOutOfRangeException(nameof(code), code, "Not a code of the sync protocol."),
    };
}
