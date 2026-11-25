using System.Text.Json.Nodes;
using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
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
public sealed class ReadingSyncService(
    IBookAccess library, IReadingStateRepository states, IReadingSessionRepository sessions, IChapterLookup chapters,
    TimeProvider clock)
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
        var keys = TransitionalLocators.ChapterKeysOf(state);
        var result = await states.AdvanceAsync(userId, bookId, state, request.ExpectedRevision, keys, ct);
        return result.Accepted ? SyncResult.Ok(result.Current!.ToDto()) : await ClassifyLossAsync(userId, bookId, state, keys, request.ExpectedRevision, result.Current, ct);
    }

    private async Task<SyncResult> ClassifyLossAsync(
        Guid userId, Guid bookId, ReadingState sent, TransitionalChapterKeys keys, long? expectedRevision, ReadingState? stored, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        var current = book.CurrentFile;
        if (sent.FileId != current?.Id)
            return await library.GetFileAsync(userId, bookId, sent.FileId, ct) is null
                ? SyncResult.UnknownFile
                : SyncResult.FileReplaced(current, stored?.Revision, stored?.ToDto());
        if (MisfitsTheFile(sent, stored, current!.Format) is { } misfit) return misfit;
        if (await NamesAMissingChapterAsync(userId, bookId, sent, keys, stored, ct) is { } noChapter) return noChapter;
        // A first writer had no frontier to lose, so a reset is news only to a writer that read an older revision.
        return expectedRevision is not null && stored?.ResetRevision > expectedRevision
            ? SyncResult.Fail(SyncCodes.Reset, stored!.Revision, stored.ToDto(), current?.Id, current?.ToDto())
            : SyncResult.StaleRevision(stored?.Revision, stored?.ToDto(), current);
    }

    /// <summary>
    /// The write SQL's scheme guard asked again, to name the loss (#1122): the position's scheme, and the offered
    /// frontier's when the write would have stored it, as the chapter guard below.
    /// </summary>
    private static SyncResult? MisfitsTheFile(ReadingState sent, ReadingState? stored, string format)
    {
        var (frontier, offered) = ReadingState.Furthest((sent.FrontierLocator, sent.FrontierFraction), (sent.CurrentLocator, sent.BookFraction));
        var frontierStored = stored?.FrontierFraction is not { } kept || offered > kept;
        return FitsFile(SchemeOf(sent.CurrentLocator), format, "currentLocator")
            ?? (frontierStored && frontier is not null ? FitsFile(SchemeOf(frontier), format, "frontierLocator") : null);
    }

    /// <summary>
    /// The write SQL's chapter guard asked again, to name the loss: the position's chapter, and the offered frontier's
    /// when the write would have stored it (no stored frontier, or the offered one is further); neither for a locator
    /// already stored (the position's against the stored position, the frontier's against either). Null: none is missing.
    /// </summary>
    private async Task<SyncResult?> NamesAMissingChapterAsync(Guid userId, Guid bookId, ReadingState sent, TransitionalChapterKeys keys, ReadingState? stored, CancellationToken ct)
    {
        var (frontier, offered) = ReadingState.Furthest((sent.FrontierLocator, sent.FrontierFraction), (sent.CurrentLocator, sent.BookFraction));
        var frontierStored = stored?.FrontierFraction is not { } kept || offered > kept;
        bool Stored(string? locator, params string?[] storedOnes) =>
            stored?.FileId == sent.FileId && storedOnes.Any(s => s is not null && JsonNode.DeepEquals(JsonNode.Parse(s), JsonNode.Parse(locator!)));
        var current = Stored(sent.CurrentLocator, stored?.CurrentLocator) ? null : keys.Current;
        var offeredKey = frontierStored && !Stored(frontier, stored?.CurrentLocator, stored?.FrontierLocator) ? keys.Frontier : null;
        foreach (var key in new[] { current, offeredKey }.OfType<string>().Distinct())
            if (await chapters.CheckKeyAsync(userId, bookId, sent.FileId, key, ct) is { } missing)
                return missing;
        return null;
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

    /// <summary>
    /// <c>GET /me/v2/stats</c> (#1366): the <paramref name="period"/> holding today in <paramref name="timeZone"/>
    /// (week, month, halfyear = this month and the 5 before it, year), with all-time streaks. Both are required: days are the user's, not the server's.
    /// </summary>
    public async Task<SyncResult> StatsAsync(Guid userId, string? period, string? timeZone, CancellationToken ct)
    {
        var badZone = SyncResult.Invalid("tz", "tz is an IANA time zone, such as Europe/Kyiv.");
        if (!ReadingStats.IsPeriod(period)) return SyncResult.Invalid("period", "period is week, month, halfyear or year.");
        if (string.IsNullOrWhiteSpace(timeZone)) return badZone;
        // Postgres is the one zone database: it names today and the days, and refuses a zone it does not know.
        var totals = await sessions.DailyTotalsAsync(userId, timeZone, ct);
        return totals is null ? badZone : SyncResult.Ok(ReadingStats.Build(period!, totals.Today, totals.Days));
    }

    public async Task<SyncResult> SaveSessionAsync(Guid userId, Guid clientSessionId, ReadingSessionRequest r, CancellationToken ct)
    {
        var invalid = ClientId(clientSessionId, "clientSessionId") ?? Required(r.StartedAt, "startedAt") ?? Required(r.EndedAt, "endedAt")
            ?? (r.EndedAt < r.StartedAt ? SyncResult.Invalid("endedAt", "endedAt is before startedAt.") : null)
            ?? NotFuture(r.EndedAt, clock.GetUtcNow(), "endedAt")
            ?? (r.DurationSeconds >= 0 ? null : SyncResult.Invalid("durationSeconds", "durationSeconds must be zero or more."))
            ?? (r.WordsRead >= 0 ? null : SyncResult.Invalid("wordsRead", "wordsRead must be zero or more."))
            ?? Fraction(r.StartPercent, "startPercent") ?? Fraction(r.EndPercent, "endPercent");
        if (invalid is not null) return invalid;
        // The FK refuses another user's book too, but as an exception; this makes it the client's 404.
        if (r.BookId is { } bookId && await library.MissingBookOrFileAsync(userId, bookId, null, ct) is { } missing) return missing;

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
        return SyncResult.Written(saved.Outcome, saved.Row!.ToDto());
    }

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, string? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => states.ListChangedAsync(userId, since, after, take, ct),
            s => (s.UpdatedAt, s.BookId), s => s.ToDto());
}
