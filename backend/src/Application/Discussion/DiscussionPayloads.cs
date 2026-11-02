using System.Text.Json;
using Application.Common;
using Contracts.V2;

namespace Application.Discussion;

/// <summary>
/// The <c>payload_sha256</c> of a share and of a checkpoint: the "Canonical JSON" table's Share and
/// Checkpoint rows, exactly these fields under these names, through <see cref="CanonicalPayload.Sha256"/>.
/// The hash of the write as the row stores it; a deleted share leaves it unchanged.
/// </summary>
public static class DiscussionPayloads
{
    public static string ShareSha256(Guid bookId, ShareChapterRequest r) =>
        CanonicalPayload.Sha256(new Share(bookId, r.FileId, r.ChapterKey!, r.ChapterTitle, r.ChapterText!, r.Notes!.Value, r.Language));

    public static string CheckpointSha256(Guid bookId, CheckpointRequest r) =>
        CanonicalPayload.Sha256(new Checkpoint(
            bookId, r.FileId, r.ChapterKey, r.SharedChapterId, r.Topic!,
            r.ReaderThoughts!, r.AssistantSuggestions!, r.Conclusions!, r.OpenQuestions!, r.Language!));

    private sealed record Share(
        Guid BookId, Guid? FileId, string ChapterKey, string? ChapterTitle, string ChapterText, JsonElement Notes, string? Language);

    private sealed record Checkpoint(
        Guid BookId, Guid? FileId, string? ChapterKey, Guid? SharedChapterId, string Topic, string?[] ReaderThoughts,
        string?[] AssistantSuggestions, string?[] Conclusions, string?[] OpenQuestions, string Language);
}
