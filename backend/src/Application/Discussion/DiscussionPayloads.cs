using System.Text.Json;
using Application.Common;
using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The <c>payload_sha256</c> of a share and of a checkpoint: the "Canonical JSON" table's Share and
/// Checkpoint rows, exactly these fields under these names, through <see cref="CanonicalPayload.Sha256"/>.
/// Built from the row as written (its JSON columns as text), so the M3 ETL can hash a migrated row the
/// same way. The stored hash is of that first write: when a share is deleted its checkpoints' shared_chapter_id
/// becomes null but their payload_sha256 stays, so a retry still naming the deleted share replays. The ETL
/// hashes migrated rows as migrated.
/// </summary>
public static class DiscussionPayloads
{
    public static string ShareSha256(SharedChapter s) =>
        CanonicalPayload.Sha256(new Share(s.BookId, s.FileId, s.ChapterKey, s.ChapterTitle, s.ChapterText, Parse(s.NotesSnapshot), s.Language));

    public static string CheckpointSha256(DiscussionCheckpoint c) =>
        CanonicalPayload.Sha256(new Checkpoint(
            c.BookId, c.FileId, c.ChapterKey, c.SharedChapterId, c.Topic,
            Parse(c.ReaderThoughts), Parse(c.AssistantSuggestions), Parse(c.Conclusions), Parse(c.OpenQuestions), c.Language));

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private sealed record Share(
        Guid BookId, Guid? FileId, string ChapterKey, string? ChapterTitle, string ChapterText, JsonElement Notes, string? Language);

    private sealed record Checkpoint(
        Guid BookId, Guid? FileId, string? ChapterKey, Guid? SharedChapterId, string Topic, JsonElement ReaderThoughts,
        JsonElement AssistantSuggestions, JsonElement Conclusions, JsonElement OpenQuestions, string Language);
}
