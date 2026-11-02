using Application.Common;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Reading;
using static Application.Sync.SyncValidation;

namespace Application.Reading;

/// <summary>
/// The /me/v2 reading use cases: state, reset, sessions and the reading feed. A lost state write is
/// classified here, not in the repository (v2-sync-protocol.md "The revision rule"): after a
/// replacement <c>Current</c> is null exactly as for a book that never had state, and after a reset it
/// is a row with a higher revision exactly as after a move, so only the library can tell them apart.
/// A removed book still accepts state and sessions (owner decision 11).
/// </summary>
public sealed class ReadingSyncService(ILibraryRepository library, IReadingStateRepository states, IReadingSessionRepository sessions)
{
    public async Task<SyncResult> GetAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var state = await states.GetAsync(userId, bookId, ct);
        return state is not null ? SyncResult.Ok(state.ToDto()) : await MissingAsync(userId, bookId, ct);
    }

    /// <summary>No state: 404, naming the book when it is the book that is missing.</summary>
    private async Task<SyncResult> MissingAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        await library.ExistsAsync(userId, bookId, ct) ? SyncResult.NotFound : SyncResult.BookNotFound;

    public async Task<SyncResult> WriteAsync(Guid userId, Guid bookId, ReadingStateRequest request, CancellationToken ct)
    {
        if (Validate(request) is { } invalid) return invalid;
        var state = new ReadingState
        {
            FileId = request.FileId!.Value,
            CurrentLocator = request.CurrentLocator!.Value.GetRawText(),
            BookFraction = request.BookFraction!.Value,
            FrontierLocator = request.FrontierLocator?.GetRawText(),
            FrontierFraction = request.FrontierFraction,
            CompletedAt = request.CompletedAt,
            ClientRecordedAt = request.ClientRecordedAt!.Value,
        };
        var result = await states.AdvanceAsync(userId, bookId, state, request.ExpectedRevision, ct);
        return result.Accepted ? SyncResult.Ok(result.Current!.ToDto()) : await ClassifyLossAsync(userId, bookId, state.FileId, request.ExpectedRevision, result.Current, ct);
    }

    private async Task<SyncResult> ClassifyLossAsync(
        Guid userId, Guid bookId, Guid fileId, long? expectedRevision, ReadingState? stored, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        var current = book.CurrentFile;
        if (fileId != current?.Id)
            return await library.GetFileAsync(userId, bookId, fileId, ct) is null
                ? SyncResult.UnknownFile
                : SyncResult.FileReplaced(current, stored?.Revision, stored?.ToDto());
        // A first writer had no frontier to lose, so a reset is news only to a writer that read an older revision.
        return expectedRevision is not null && stored?.ResetRevision > expectedRevision
            ? SyncResult.Fail(SyncCodes.Reset, stored!.Revision, stored.ToDto(), current?.Id, current?.ToDto())
            : SyncResult.StaleRevision(stored?.Revision, stored?.ToDto(), current);
    }

    private static SyncResult? Validate(ReadingStateRequest r) =>
        Required(r.FileId, "fileId")
        ?? Required(r.CurrentLocator, "currentLocator") ?? Locator(r.CurrentLocator!.Value, "currentLocator", LocatorUse.Position)
        ?? Required(r.BookFraction, "bookFraction") ?? Fraction(r.BookFraction, "bookFraction")
        ?? Required(r.ClientRecordedAt, "clientRecordedAt")
        ?? ((r.FrontierLocator is null) != (r.FrontierFraction is null)
            ? SyncResult.Invalid("frontierLocator", "frontierLocator and frontierFraction are sent together or not at all.") : null)
        ?? (r.FrontierLocator is { } frontier
            ? Locator(frontier, "frontierLocator", LocatorUse.Position) ?? Fraction(r.FrontierFraction, "frontierFraction") : null);

    public async Task<SyncResult> ResetAsync(Guid userId, Guid bookId, ResetReadingStateRequest request, CancellationToken ct)
    {
        if (Required(request.ExpectedRevision, "expectedRevision") is { } invalid) return invalid;
        var result = await states.ResetAsync(userId, bookId, request.ExpectedRevision!.Value, ct);
        if (result.Accepted) return SyncResult.Ok(result.Current!.ToDto());
        return result.Current is { } stored ? SyncResult.StaleRevision(stored.Revision, stored.ToDto()) : await MissingAsync(userId, bookId, ct);
    }

    public async Task<SyncResult> SaveSessionAsync(Guid userId, Guid clientSessionId, ReadingSessionRequest r, CancellationToken ct)
    {
        var invalid = Required(r.StartedAt, "startedAt") ?? Required(r.EndedAt, "endedAt")
            ?? (r.EndedAt < r.StartedAt ? SyncResult.Invalid("endedAt", "endedAt is before startedAt.") : null)
            ?? (r.DurationSeconds >= 0 ? null : SyncResult.Invalid("durationSeconds", "durationSeconds must be zero or more."))
            ?? (r.WordsRead >= 0 ? null : SyncResult.Invalid("wordsRead", "wordsRead must be zero or more."))
            ?? Fraction(r.StartPercent, "startPercent") ?? Fraction(r.EndPercent, "endPercent");
        if (invalid is not null) return invalid;
        // The FK refuses another user's book too, but as an exception; this makes it the client's 404.
        if (r.BookId is { } bookId && !await library.ExistsAsync(userId, bookId, ct)) return SyncResult.BookNotFound;

        var saved = await sessions.SaveAsync(userId, new ReadingSession
        {
            ClientSessionId = clientSessionId,
            BookId = r.BookId,
            StartedAt = r.StartedAt!.Value,
            EndedAt = r.EndedAt!.Value,
            DurationSeconds = r.DurationSeconds!.Value,
            WordsRead = r.WordsRead!.Value,
            StartPercent = r.StartPercent!.Value,
            EndPercent = r.EndPercent!.Value,
        }, ct);
        var dto = saved.Row!.ToDto();
        return saved.Outcome == WriteOutcome.Created ? SyncResult.Created(dto) : SyncResult.Ok(dto);
    }

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, string? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => states.ListChangedAsync(userId, since, after, take, ct),
            s => (s.UpdatedAt, s.BookId), s => s.ToDto());
}
