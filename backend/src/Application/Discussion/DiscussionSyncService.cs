using System.Text;
using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Discussion;
using static Application.Sync.SyncValidation;
using static Contracts.V2.SyncLimits;

namespace Application.Discussion;

/// <summary>
/// The /me/v2 shares and checkpoints (v2-sync-protocol.md "Payloads → Shares and checkpoints", M2.4
/// rows): online-only appends keyed by <c>operationId</c>, never pulled (S7). The book and file are
/// checked before any write (<see cref="LibraryProvenance"/>, M1.4 delta 1); a removed book still
/// takes both (owner decision 11). The same-chapter rule of a checkpoint's share is the repository's
/// insert; this maps its outcome. Saving never touches reading state.
/// </summary>
public sealed class DiscussionSyncService(ILibraryRepository library, ISharedChapterRepository shares, ICheckpointRepository checkpoints)
{
    public async Task<SyncResult> ShareAsync(Guid userId, Guid bookId, ShareChapterRequest r, CancellationToken ct)
    {
        if (Share(r) is { } invalid) return invalid;
        if (await library.MissingBookOrFileAsync(userId, bookId, r.FileId, ct) is { } missing) return missing;

        var written = await shares.ShareAsync(new SharedChapter
        {
            Id = Guid.CreateVersion7(),
            UserId = userId,
            BookId = bookId,
            FileId = r.FileId,
            ChapterKey = r.ChapterKey!,
            ChapterTitle = r.ChapterTitle,
            ChapterText = r.ChapterText!,
            NotesSnapshot = r.Notes!.Value.GetRawText(),
            Language = r.Language,
            OperationId = r.OperationId!.Value,
            PayloadSha256 = DiscussionPayloads.ShareSha256(bookId, r),
        }, ct);
        return SyncResult.Written(written.Outcome, written.Row?.ToDto());
    }

    private static SyncResult? Share(ShareChapterRequest r) =>
        ClientId(r.OperationId, "operationId") ?? RequiredText(r.ChapterKey, "chapterKey", MaxChapterKey)
        ?? Text(r.ChapterTitle, "chapterTitle", MaxChapterTitle) ?? RequiredUtf8(r.ChapterText, "chapterText", MaxChapterTextBytes)
        ?? JsonArray(r.Notes, "notes", MaxNotesBytes) ?? Text(r.Language, "language", MaxLanguage);

    /// <summary>Newest first, unpaged: a book has few (M1.4 as merged).</summary>
    public async Task<SyncResult> ListSharesAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var listed = await shares.ListForBookAsync(userId, bookId, ct);
        // Only an empty list needs the book asked: "none yet" or "not the user's".
        if (listed.Count == 0 && !await library.ExistsAsync(userId, bookId, ct)) return SyncResult.BookNotFound;
        return SyncResult.Ok(listed.Select(s => s.ToDto()).ToList());
    }

    /// <summary>
    /// A share has no tombstone, so a second delete is 404 like an id never the user's: the client
    /// drops it either way ("Conflict codes", <c>not_found</c>). Its checkpoints lose only the link.
    /// </summary>
    public async Task<SyncResult> DeleteShareAsync(Guid userId, Guid id, CancellationToken ct) =>
        await shares.DeleteAsync(userId, id, ct) ? SyncResult.NoContent : SyncResult.NotFound;

    public async Task<SyncResult> SaveCheckpointAsync(Guid userId, Guid bookId, CheckpointRequest r, CancellationToken ct)
    {
        if (Checkpoint(r) is { } invalid) return invalid;
        if (await library.MissingBookOrFileAsync(userId, bookId, r.FileId, ct) is { } missing) return missing;

        var written = await checkpoints.AppendAsync(new DiscussionCheckpoint
        {
            Id = Guid.CreateVersion7(),
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
            PayloadSha256 = DiscussionPayloads.CheckpointSha256(bookId, r),
        }, ct);
        return written.Outcome == WriteOutcome.ShareMismatch
            ? SyncResult.Fail(SyncCodes.ShareMismatch)
            : SyncResult.Written(written.Outcome, written.Row?.ToDto());
    }

    private static SyncResult? Checkpoint(CheckpointRequest r)
    {
        if ((ClientId(r.OperationId, "operationId") ?? RequiredText(r.Topic, "topic", MaxTopic)) is { } invalid) return invalid;
        var (items, bytes) = (0, 0);
        foreach (var (field, section) in (ReadOnlySpan<(string, string?[]?)>)[
            ("readerThoughts", r.ReaderThoughts), ("assistantSuggestions", r.AssistantSuggestions),
            ("conclusions", r.Conclusions), ("openQuestions", r.OpenQuestions)])
        {
            if (Section(field, section) is { } badSection) return badSection;
            items += section!.Length;
            bytes += section.Sum(i => Encoding.UTF8.GetByteCount(i!));
        }
        if (items == 0) return SyncResult.Invalid("readerThoughts", "At least one section must have an item.");
        if (bytes > MaxSectionsBytes) return SyncResult.Invalid("readerThoughts", $"The four sections together are at most {MaxSectionsBytes / 1024} KB.");
        return RequiredText(r.Language, "language", MaxLanguage)
            ?? (r.ChapterKey is null ? null : RequiredText(r.ChapterKey, "chapterKey", MaxChapterKey))
            // A share is always of one chapter, so naming one without the chapter could never match.
            ?? (r.SharedChapterId is not null && r.ChapterKey is null ? SyncResult.Invalid("chapterKey", "chapterKey is required with sharedChapterId.") : null);
    }

    // Ordered, and each item a non-blank line: an empty one would count toward "not all empty" while saying nothing.
    private static SyncResult? Section(string field, string?[]? items) =>
        Required(items, field)
        ?? (items!.Length > MaxSectionItems ? SyncResult.Invalid(field, $"{field} has at most {MaxSectionItems} items.") : null)
        ?? items.Select((item, i) => RequiredText(item, $"{field}[{i}]")).FirstOrDefault(e => e is not null);

    /// <summary>Oldest first, in pages of <c>(created_at, id)</c>; <c>cursor</c> is null on the last page.</summary>
    public async Task<SyncResult> ListCheckpointsAsync(Guid userId, Guid bookId, string? chapterKey, string? cursor, string? limit, CancellationToken ct)
    {
        if (ChangeFeed.Limit(limit, out var take) is { } badLimit) return badLimit;
        if (ChangeFeed.Cursor(cursor, out var after) is { } badCursor) return badCursor;
        if (Text(chapterKey, "chapterKey", MaxChapterKey) is { } badChapterKey) return badChapterKey;

        var page = await checkpoints.ListAsync(userId, bookId, string.IsNullOrEmpty(chapterKey) ? null : chapterKey, take,
            after is { } at ? new CheckpointCursor(at.At, at.Id) : null, ct);
        // Only an empty page needs the book asked: "none (left)" or "not the user's".
        if (page.Items.Count == 0 && !await library.ExistsAsync(userId, bookId, ct)) return SyncResult.BookNotFound;
        var next = page.Next is { } n ? ChangeFeed.CursorOf((n.CreatedAt, n.Id)) : null;
        return SyncResult.Ok(new ChangeFeedDto<CheckpointDto>(page.Items.Select(c => c.ToDto()).ToList(), next, next is not null));
    }

    public async Task<SyncResult> DeleteCheckpointAsync(Guid userId, Guid id, CancellationToken ct) =>
        await checkpoints.DeleteAsync(userId, id, ct) ? SyncResult.NoContent : SyncResult.NotFound;

    /// <summary>The per-book opt-in (discussion PDD "Domain story"): a preference, so the last PUT wins; answered with the book.</summary>
    public async Task<SyncResult> SetCheckpointSavingAsync(Guid userId, Guid bookId, CheckpointSavingRequest r, CancellationToken ct)
    {
        if (Required(r.Enabled, "enabled") is { } missing) return missing;
        return await library.SetCheckpointSavingAsync(userId, bookId, r.Enabled!.Value, ct) is { } book
            ? SyncResult.Ok(book.ToDto()) : SyncResult.BookNotFound;
    }
}
