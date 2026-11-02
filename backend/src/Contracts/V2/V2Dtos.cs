using System.Text.Json;
using System.Text.Json.Serialization;

namespace Contracts.V2;

// The /me/v2 wire shapes (docs/01-architecture/v2-sync-protocol.md "Payloads"). Requests carry
// nullable members so a missing required field is a 400 that names it, not a default value.
// Locators, toc and other opaque client JSON travel as JsonElement and are stored as sent.

/// <summary>
/// The one error body of every 4xx/503 under /me/v2 ("The 409 body"): <c>current</c> is the stored
/// row the write lost to, <c>revision</c> repeats its revision.
/// </summary>
public sealed record V2Error(
    string Code,
    string Message,
    long? Revision = null,
    object? Current = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? FileId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BookFileDto? CurrentFile = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Field = null);

public sealed record V2StatusDto(long MaxPartBytes);

/// <summary>One page of a change feed: pass <see cref="Cursor"/> back to continue (<see cref="HasMore"/>) or, later, to resume.</summary>
public sealed record ChangeFeedDto<T>(IReadOnlyList<T> Items, string? Cursor, bool HasMore);

public sealed record BookDto(
    Guid Id, string Title, string? Author, string? Language, string? Description, string? Genre, int? PublishedYear,
    string[] Tags, bool CheckpointSavingEnabled, bool HasCover, long Revision,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? RemovedAt, BookFileDto? CurrentFile);

public sealed record BookFileDto(
    Guid Id, string Sha256, long ByteSize, string OriginalName, string Format, int? PageCount, [property: JsonConverter(typeof(RawJsonConverter))] string? Toc,
    bool IsCurrent, bool HasContent, DateTimeOffset CreatedAt);

/// <summary>A file version as a client sends it: on import (with <see cref="Id"/>) and on replace (the path's id wins).</summary>
public sealed record BookFileRequest(
    Guid? Id, string? Sha256, long? ByteSize, string? OriginalName, string? Format, int? PageCount, [property: JsonConverter(typeof(RawJsonConverter))] string? Toc);

public sealed record ImportBookRequest(
    string? Title, string? Author, string? Language, string? Description, string? Genre, int? PublishedYear,
    string[]? Tags, BookFileRequest? File);

/// <summary>
/// A metadata edit with merge-patch semantics: an absent member keeps the stored value, an explicit
/// null clears it. <see cref="JsonElement"/> because only it tells absent (Undefined) from null.
/// </summary>
public sealed record PatchBookRequest(
    long? ExpectedRevision, JsonElement Title, JsonElement Author, JsonElement Language, JsonElement Description,
    JsonElement Genre, JsonElement PublishedYear, JsonElement Tags);

/// <summary><c>{replacesFileId, file:{…}}</c>: the import's file shape, and the current file the client saw (null: none).</summary>
public sealed record ReplaceFileRequest(Guid? ReplacesFileId, BookFileRequest? File);

public sealed record FileReplacementDto(BookFileDto Current, BookFileDto? Superseded);

public sealed record ReadingStateRequest(
    long? ExpectedRevision, Guid? FileId, JsonElement? CurrentLocator, decimal? BookFraction,
    JsonElement? FrontierLocator, decimal? FrontierFraction, DateTimeOffset? CompletedAt, DateTimeOffset? ClientRecordedAt);

public sealed record ReadingStateDto(
    Guid BookId, Guid FileId, [property: JsonConverter(typeof(RawJsonConverter))] string CurrentLocator, decimal BookFraction, [property: JsonConverter(typeof(RawJsonConverter))] string? FrontierLocator,
    decimal? FrontierFraction, DateTimeOffset? CompletedAt, DateTimeOffset ClientRecordedAt, DateTimeOffset UpdatedAt,
    long Revision, long? ResetRevision);

public sealed record ResetReadingStateRequest(long? ExpectedRevision);

public sealed record ReadingSessionRequest(
    Guid? BookId, DateTimeOffset? StartedAt, DateTimeOffset? EndedAt, int? DurationSeconds, int? WordsRead,
    decimal? StartPercent, decimal? EndPercent);

public sealed record ReadingSessionDto(
    Guid ClientSessionId, Guid? BookId, DateTimeOffset StartedAt, DateTimeOffset EndedAt, int DurationSeconds,
    int WordsRead, decimal StartPercent, decimal EndPercent, DateTimeOffset CreatedAt);

public sealed record AnnotationRequest(
    long? ExpectedRevision, Guid? BookId, Guid? FileId, string? SelectedText, string? NoteText, JsonElement? Locator, string? Color);

public sealed record AnnotationDto(
    Guid Id, Guid BookId, Guid? FileId, string SelectedText, string? NoteText, [property: JsonConverter(typeof(RawJsonConverter))] string? Locator, string Color,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? DeletedAt, long Revision);
