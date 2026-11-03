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

/// <summary><see cref="ContentRemovedAt"/>: the reader stopped syncing this version, so no client uploads its bytes on its own.</summary>
public sealed record BookFileDto(
    Guid Id, string Sha256, long ByteSize, string OriginalName, string Format, int? PageCount, [property: JsonConverter(typeof(RawJsonConverter))] string? Toc,
    bool IsCurrent, bool HasContent, DateTimeOffset CreatedAt, DateTimeOffset? ContentRemovedAt);

/// <summary>A part stored: its index and its size in bytes.</summary>
public sealed record UploadedPartDto(int Index, long Size);

public sealed record CompleteContentRequest(int? PartCount);

/// <summary><c>current</c> of a 422 <c>content_mismatch</c>: what the file version says and what the parts hash to; <see cref="ByteSize"/> is the parts' total.</summary>
public sealed record ContentMismatchDto(string ExpectedSha256, string ActualSha256, long ByteSize);

/// <summary><c>current</c> of a 413 <c>quota_exceeded</c>: the bytes the server holds for the user, and the limit.</summary>
public sealed record StorageQuotaDto(long Used, long Limit);

/// <summary>Transitional (dropped at M6.4): a server-extracted chapter in a table of contents. <see cref="ChapterNumber"/> orders, never displays.</summary>
public sealed record ChapterHeadingDto(string ChapterKey, int ChapterNumber, string Title, int? WordCount);

/// <summary>
/// Transitional (dropped at M6.4): a file version's chapters, and its latest extraction job's status
/// (<c>queued</c>, <c>processing</c>, <c>succeeded</c>, <c>failed</c>; null: none). Empty while it runs.
/// </summary>
public sealed record FileChaptersDto(IReadOnlyList<ChapterHeadingDto> Items, string? Ingestion);

/// <summary>Transitional (dropped at M6.4): one chapter and its neighbours in reading order (null at an end).</summary>
public sealed record ChapterDto(
    string ChapterKey, int ChapterNumber, string Title, string Html, int? WordCount, ChapterHeadingDto? Previous, ChapterHeadingDto? Next);

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

/// <summary>A card save; <see cref="Example"/>, when sent, is added to whichever card the key resolves to.</summary>
public sealed record SaveVocabularyWordRequest(
    Guid? Id, string? Language, string? Word, string? Translation, string? Definition, VocabularyExampleRequest? Example);

public sealed record VocabularyExampleRequest(
    Guid? OperationId, string? Sentence, string? ContextualTranslation, Guid? BookId, Guid? FileId, string? ChapterKey, string? BookTitle);

/// <summary>A card edit with merge-patch semantics, as <see cref="PatchBookRequest"/>: absent keeps, null clears.</summary>
public sealed record PatchVocabularyWordRequest(long? ExpectedRevision, JsonElement Translation, JsonElement Definition);

public sealed record RestoreVocabularyWordRequest(long? ExpectedRevision);

public sealed record VocabularyReviewRequest(
    Guid? OperationId, Guid? WordId, string? ReviewMode, bool? IsCorrect, int? ResponseTimeMs, DateTimeOffset? ClientRecordedAt);

/// <summary>
/// The word card ("Payloads → Vocabulary"); <c>wordKey</c> is the server's and is not sent.
/// <see cref="Example"/> is on a save only: whether its example was <c>added</c> or <c>replayed</c>.
/// </summary>
public sealed record VocabularyWordDto(
    Guid Id, string Language, string Word, string? Translation, string? Definition,
    int Stage, decimal IntervalDays, int ConsecutiveCorrect, DateTimeOffset NextReviewAt, DateTimeOffset? LastReviewedAt,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? DeletedAt, DateTimeOffset? RetiredAt, long Revision,
    IReadOnlyList<VocabularyExampleDto> Examples,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Example = null);

public sealed record VocabularyExampleDto(
    Guid Id, Guid OperationId, string Sentence, string? ContextualTranslation, Guid? BookId, Guid? FileId, string? ChapterKey,
    string? BookTitle, DateTimeOffset CreatedAt);

public sealed record VocabularyReviewDto(
    Guid Id, Guid OperationId, Guid WordId, string ReviewMode, bool IsCorrect, int? ResponseTimeMs,
    int StageBefore, int StageAfter, DateTimeOffset ClientRecordedAt, DateTimeOffset CreatedAt);

/// <summary>An answer and the card with the schedule the server applied to it (S3).</summary>
public sealed record RecordedReviewDto(VocabularyReviewDto Review, VocabularyWordDto Word);

/// <summary>A chapter snapshot shared with an assistant ("Payloads → Shares and checkpoints"); <see cref="Notes"/> is a JSON array, may be empty.</summary>
public sealed record ShareChapterRequest(
    Guid? OperationId, Guid? FileId, string? ChapterKey, string? ChapterTitle, string? ChapterText, JsonElement? Notes, string? Language);

public sealed record SharedChapterDto(
    Guid Id, Guid OperationId, Guid BookId, Guid? FileId, string ChapterKey, string? ChapterTitle, string ChapterText,
    [property: JsonConverter(typeof(RawJsonConverter))] string Notes, string? Language, DateTimeOffset CreatedAt);

/// <summary>One saved stage of a discussion: the four sections may be empty, not all four.</summary>
public sealed record CheckpointRequest(
    Guid? OperationId, string? Topic, string?[]? ReaderThoughts, string?[]? AssistantSuggestions, string?[]? Conclusions,
    string?[]? OpenQuestions, string? Language, string? ChapterKey, Guid? FileId, Guid? SharedChapterId);

public sealed record CheckpointDto(
    Guid Id, Guid OperationId, Guid BookId, Guid? FileId, string? ChapterKey, Guid? SharedChapterId, string Topic,
    [property: JsonConverter(typeof(RawJsonConverter))] string ReaderThoughts,
    [property: JsonConverter(typeof(RawJsonConverter))] string AssistantSuggestions,
    [property: JsonConverter(typeof(RawJsonConverter))] string Conclusions,
    [property: JsonConverter(typeof(RawJsonConverter))] string OpenQuestions,
    string Language, DateTimeOffset CreatedAt);

public sealed record CheckpointSavingRequest(bool? Enabled);
