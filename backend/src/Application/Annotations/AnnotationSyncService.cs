using System.Text.Json.Nodes;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Annotations;
using static Application.Sync.SyncValidation;

namespace Application.Annotations;

/// <summary>
/// The /me/v2 annotation use cases. The conflict codes are derived here, not in the repository
/// (v2-sync-protocol.md "M1.3 as merged", delta 1): the book and the file are checked before the
/// write, because the schema would refuse a bad one only at commit (a deferred FK, a 500 that an
/// outbox retries forever). A removed book still accepts annotations (owner decision 11).
/// </summary>
public sealed class AnnotationSyncService(ILibraryRepository library, IAnnotationRepository annotations, TimeProvider clock)
{
    private const string DefaultColor = "yellow";

    public async Task<SyncResult> SaveAsync(Guid userId, Guid id, AnnotationRequest r, CancellationToken ct)
    {
        var invalid = Required(r.BookId, "bookId")
            ?? (string.IsNullOrWhiteSpace(r.SelectedText) ? SyncResult.Invalid("selectedText", "selectedText is required.") : null)
            ?? Text(r.SelectedText, "selectedText") ?? Text(r.NoteText, "noteText")
            ?? (r.Color is not null && string.IsNullOrWhiteSpace(r.Color) ? SyncResult.Invalid("color", "color must not be blank.") : Text(r.Color, "color"))
            ?? (r.Locator is { } locator
                ? Required(r.FileId, "fileId") ?? Locator(locator, "locator", LocatorUse.Annotation) : null);
        if (invalid is not null) return invalid;
        var bookId = r.BookId!.Value;
        if (await library.GetAsync(userId, bookId, ct) is null) return SyncResult.BookNotFound();
        // Any version of the book, current or not: a highlight made offline in a superseded one is still valid provenance.
        if (r.FileId is { } fileId && await library.GetFileAsync(userId, bookId, fileId, ct) is null)
            return SyncResult.Fail(new V2Error(SyncCodes.UnknownFile, "Push the file version before its annotations."));

        var sent = new Annotation
        {
            Id = id,
            BookId = bookId,
            FileId = r.FileId,
            SelectedText = r.SelectedText!,
            NoteText = r.NoteText,
            Locator = r.Locator?.GetRawText(),
            Color = r.Color ?? DefaultColor,
        };
        var result = await annotations.SaveAsync(userId, sent, r.ExpectedRevision, ct);
        if (result.Accepted)
            return r.ExpectedRevision is null ? SyncResult.Created(result.Current!.ToDto()) : SyncResult.Ok(result.Current!.ToDto());

        return result.Current switch
        {
            // Not the user's: a client id that collides with someone else's row.
            null => SyncResult.Fail(new V2Error(SyncCodes.IdConflict, "Mint a new id and retry.")),
            { DeletedAt: not null } tombstone =>
                SyncResult.Fail(new V2Error(SyncCodes.Deleted, "This highlight was deleted.", tombstone.Revision, tombstone.ToDto())),
            // A retry of a write that landed, whose response was lost.
            { } stored when SameContent(stored, sent) => SyncResult.Ok(stored.ToDto()),
            { } stored => SyncResult.Fail(new V2Error(SyncCodes.StaleRevision, "Another device changed this highlight.", stored.Revision, stored.ToDto())),
        };
    }

    // jsonb keeps neither key order nor spacing, so locators compare as JSON values.
    private static bool SameContent(Annotation stored, Annotation sent) =>
        (stored.BookId, stored.FileId, stored.SelectedText, stored.NoteText, stored.Color)
            == (sent.BookId, sent.FileId, sent.SelectedText, sent.NoteText, sent.Color)
        && JsonNode.DeepEquals(Parse(stored.Locator), Parse(sent.Locator));

    private static JsonNode? Parse(string? json) => json is null ? null : JsonNode.Parse(json);

    /// <summary>Idempotent: deleting a tombstone answers it again. After the delete, a row of the user is a tombstone (none comes back to life).</summary>
    public async Task<SyncResult> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await annotations.DeleteAsync(userId, id, ct);
        return await annotations.GetAsync(userId, id, ct) is { } tombstone
            ? SyncResult.Ok(tombstone.ToDto())
            : SyncResult.NotFound();
    }

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, int? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit, clock.GetUtcNow(),
            (since, after, take) => annotations.ListChangedAsync(userId, since, after, take, ct),
            a => (a.UpdatedAt, a.Id), a => a.ToDto());
}
