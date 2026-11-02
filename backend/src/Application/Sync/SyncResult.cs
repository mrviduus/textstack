using Contracts.V2;

namespace Application.Sync;

/// <summary>The HTTP class of a /me/v2 answer; the endpoint maps it to a status code and nothing else.</summary>
public enum SyncStatus
{
    Ok,
    Created,
    NoContent,
    BadRequest,
    NotFound,
    Conflict,
}

/// <summary>What a V2 use case answers: a status and its body (a DTO, a <see cref="V2Error"/>, or nothing).</summary>
public sealed record SyncResult(SyncStatus Status, object? Body)
{
    public static SyncResult Ok(object body) => new(SyncStatus.Ok, body);
    public static SyncResult Created(object body) => new(SyncStatus.Created, body);
    public static readonly SyncResult NoContent = new(SyncStatus.NoContent, null);

    /// <summary>A failure whose status follows from its code (v2-sync-protocol.md "Conflict codes").</summary>
    public static SyncResult Fail(V2Error error) => new(StatusOf(error.Code), error);

    public static SyncResult Invalid(string field, string message) =>
        Fail(new V2Error(SyncCodes.InvalidPayload, message, Field: field));

    public static SyncResult BookNotFound() => Fail(new V2Error(SyncCodes.BookNotFound, "Push the book first."));

    public static SyncResult NotFound() => Fail(new V2Error(SyncCodes.NotFound, "The server has no such item."));

    private static SyncStatus StatusOf(string code) => code switch
    {
        SyncCodes.InvalidPayload => SyncStatus.BadRequest,
        SyncCodes.BookNotFound or SyncCodes.NotFound => SyncStatus.NotFound,
        _ => SyncStatus.Conflict,
    };
}

/// <summary>The codes M2.2 answers with (v2-sync-protocol.md "Conflict codes").</summary>
public static class SyncCodes
{
    public const string StaleRevision = "stale_revision";
    public const string Reset = "reset";
    public const string FileReplaced = "file_replaced";
    public const string UnknownFile = "unknown_file";
    public const string Deleted = "deleted";
    public const string DuplicateFile = "duplicate_file";
    public const string BookRemoved = "book_removed";
    public const string IdConflict = "id_conflict";
    public const string BookNotFound = "book_not_found";
    public const string NotFound = "not_found";
    public const string InvalidPayload = "invalid_payload";
    public const string V2Unavailable = "v2_unavailable";
}
