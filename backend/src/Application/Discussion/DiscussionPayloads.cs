using System.Text.Json;
using Application.Common;
using Contracts.V2;
using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The <c>payload_sha256</c> of a share and of a checkpoint: the "Canonical JSON" table's Share and
/// Checkpoint rows, exactly these fields under these names, through <see cref="CanonicalPayload.Sha256"/>.
/// The hash of the write as the row stores it; a deleted share leaves it unchanged. The row overloads
/// hash a stored row (the merge's rehash, the M3 ETL); a request and the row built from it hash alike.
/// </summary>
public static class DiscussionPayloads
{
    public static string ShareSha256(Guid bookId, ShareChapterRequest r) =>
        CanonicalPayload.Sha256(new SharePayload(bookId, r.FileId, r.ChapterKey!, r.ChapterTitle, r.ChapterText!, r.Notes!.Value, r.Language));

    public static string ShareSha256(SharedChapter s) =>
        CanonicalPayload.Sha256(new SharePayload(s.BookId, s.FileId, s.ChapterKey, s.ChapterTitle, s.ChapterText,
            JsonSerializer.Deserialize<JsonElement>(s.NotesSnapshot), s.Language));

    public static string CheckpointSha256(Guid bookId, CheckpointRequest r) =>
        CanonicalPayload.Sha256(new CheckpointPayload(
            bookId, r.FileId, r.ChapterKey, r.SharedChapterId, r.Topic!,
            r.ReaderThoughts!, r.AssistantSuggestions!, r.Conclusions!, r.OpenQuestions!, r.Language!));

    public static string CheckpointSha256(DiscussionCheckpoint c) =>
        CanonicalPayload.Sha256(new CheckpointPayload(
            c.BookId, c.FileId, c.ChapterKey, c.SharedChapterId, c.Topic,
            Items(c.ReaderThoughts), Items(c.AssistantSuggestions), Items(c.Conclusions), Items(c.OpenQuestions), c.Language));

    /// <summary>The row a checkpoint request stores, hash included: its four sections as JSON arrays.</summary>
    public static DiscussionCheckpoint Checkpoint(Guid id, Guid userId, Guid bookId, CheckpointRequest r) => new()
    {
        Id = id,
        UserId = userId,
        BookId = bookId,
        FileId = r.FileId,
        ChapterKey = r.ChapterKey,
        SharedChapterId = r.SharedChapterId,
        Topic = r.Topic!,
        ReaderThoughts = JsonSerializer.Serialize(r.ReaderThoughts),
        AssistantSuggestions = JsonSerializer.Serialize(r.AssistantSuggestions),
        Conclusions = JsonSerializer.Serialize(r.Conclusions),
        OpenQuestions = JsonSerializer.Serialize(r.OpenQuestions),
        Language = r.Language!,
        OperationId = r.OperationId!.Value,
        PayloadSha256 = CheckpointSha256(bookId, r),
    };

    private static string?[] Items(string section) => JsonSerializer.Deserialize<string?[]>(section)!;

    private sealed record SharePayload(
        Guid BookId, Guid? FileId, string ChapterKey, string? ChapterTitle, string ChapterText, JsonElement Notes, string? Language);

    private sealed record CheckpointPayload(
        Guid BookId, Guid? FileId, string? ChapterKey, Guid? SharedChapterId, string Topic, string?[] ReaderThoughts,
        string?[] AssistantSuggestions, string?[] Conclusions, string?[] OpenQuestions, string Language);
}
