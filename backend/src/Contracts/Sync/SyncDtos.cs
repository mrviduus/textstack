using System.Text.Json;
using System.Text.Json.Serialization;

namespace Contracts.Sync;

// The /me/v2 wire shapes (docs/internal/v2/v2-sync-protocol.md "Payloads"). Requests carry
// nullable members so a missing required field is a 400 that names it, not a default value.
// Locators, toc and other opaque client JSON travel as JsonElement and are stored as sent.

/// <summary>
/// The one error body of every 4xx/503 under /me/v2 ("The 409 body"): <c>current</c> is the stored
/// row the write lost to, <c>revision</c> repeats its revision.
/// </summary>
public sealed record SyncError(
    string Code,
    string Message,
    long? Revision = null,
    object? Current = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? FileId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BookFileDto? CurrentFile = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Field = null);

public sealed record SyncStatusDto(long MaxPartBytes);

/// <summary>One page of a change feed: pass <see cref="Cursor"/> back to continue (<see cref="HasMore"/>) or, later, to resume.</summary>
public sealed record ChangeFeedDto<T>(IReadOnlyList<T> Items, string? Cursor, bool HasMore);

public sealed record BookDto(
    Guid Id, string Title, string? Author, string? Language, string? Description, string? Genre, int? PublishedYear,
    string[] Tags, bool CheckpointSavingEnabled, bool HasCover, long Revision,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? RemovedAt, BookFileDto? CurrentFile,
    DateTimeOffset? CoverVersion);

/// <summary>
/// No <c>toc</c>: the file's TOC is read from <c>GET …/chapters</c> (ADR-033 P3), so feed rows stay small;
/// <see cref="HasToc"/> tells a reader whether to <c>PUT …/toc</c>.
/// <see cref="ContentRemovedAt"/>: the reader stopped syncing this version, so no client uploads its bytes on its own.
/// <see cref="ChapterCount"/>: the entries of the reader's TOC, on the library feed only and absent when null (no TOC).
/// </summary>
public sealed record BookFileDto(
    Guid Id, string Sha256, long ByteSize, string OriginalName, string Format, int? PageCount,
    bool IsCurrent, bool HasContent, bool HasToc, DateTimeOffset CreatedAt, DateTimeOffset? ContentRemovedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ChapterCount = null);

/// <summary>A part stored: its index and its size in bytes.</summary>
public sealed record UploadedPartDto(int Index, long Size);

public sealed record CompleteContentRequest(int? PartCount);

/// <summary><c>current</c> of a 422 <c>content_mismatch</c>: what the file version says and what the parts hash to; <see cref="ByteSize"/> is the parts' total.</summary>
public sealed record ContentMismatchDto(string ExpectedSha256, string ActualSha256, long ByteSize);

/// <summary><c>current</c> of a 413 <c>quota_exceeded</c>: the bytes the server holds for the user, and the limit.</summary>
public sealed record StorageQuotaDto(long Used, long Limit);

/// <summary>
/// An entry of a file's table of contents, from the reader's TOC (ADR-033). <see cref="ChapterNumber"/> orders, never displays.
/// <see cref="Depth"/> and <see cref="Fraction"/> (where the entry starts in the book, 0–1).
/// </summary>
public sealed record ChapterHeadingDto(string ChapterKey, int ChapterNumber, string Title, int Depth, decimal Fraction);

/// <summary>A file version's chapters: the reader's TOC, empty until a reader syncs it.</summary>
public sealed record FileChaptersDto(IReadOnlyList<ChapterHeadingDto> Items);

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

/// <summary>A share; <c>ChapterText</c> null (left out) where the caller sent it: a write's 201 or replay (#1352).</summary>
public sealed record SharedChapterDto(
    Guid Id, Guid OperationId, Guid BookId, Guid? FileId, string ChapterKey, string? ChapterTitle,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ChapterText,
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

/// <summary>An insight on a book (the assistant's conclusion, MCP <c>save_insight</c>); <c>ChapterKey</c> null = about the whole book.</summary>
public sealed record InsightRequest(string? ChapterKey, string? Text, string? Question);

/// <summary>A saved insight; its chapter's number and title come from the book's current file, null when it has none of that key.</summary>
public sealed record InsightDto(
    Guid Id, Guid BookId, string? ChapterKey, int? ChapterNumber, string? ChapterTitle, string Text, string? Question,
    string Source, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

/// <summary>
/// <c>GET /me/v2/stats</c> (#1366): reading time in the period holding today in the user's zone (week Monday..Sunday, calendar
/// month, halfyear = this month and the 5 before it, calendar year). <see cref="From"/>..<see cref="To"/> are inclusive;
/// <see cref="Minutes"/> is the sum of the bars; the streaks are over all time. One bar per day (week, month) or per month (halfyear, year), zeros included.
/// </summary>
public sealed record ReadingStatsDto(
    string Period, DateOnly From, DateOnly To, int Minutes, int DaysRead, int CurrentStreak, int BestStreak, IReadOnlyList<ReadingStatsBarDto> Bars);

/// <summary>One bucket of <see cref="ReadingStatsDto.Bars"/>; <see cref="Start"/> is its first date.</summary>
public sealed record ReadingStatsBarDto(DateOnly Start, int Minutes);
