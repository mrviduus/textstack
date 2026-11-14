using Application.Common;
using Application.Reading;
using Application.Transitional;
using Dapper;
using Domain.Reading;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IReadingStateRepository"/> on <c>textstack_v2</c>. Optimistic
/// concurrency without locks held across requests: a write names the revision it read, and the
/// statement itself checks it, so of two writers with the same revision exactly one matches.
/// The frontier CHECKs (<c>ck_reading_state_frontier</c>, <c>_frontier_ahead</c>) hold because the
/// frontier locator and fraction are always written as a pair, and never below the position.
/// </summary>
public sealed class ReadingStateRepository(V2DataSource dataSource) : IReadingStateRepository
{
    internal const string Columns =
        "book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision, reset_revision";

    private const string SelectState = $"SELECT {Columns} FROM reading_state WHERE user_id = @userId AND book_id = @bookId";

    public async Task<ReadingState?> GetAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<ReadingState>(
            new CommandDefinition(SelectState, new { userId, bookId }, cancellationToken: ct));
    }

    // Transitional (M2.7a, dropped at R8): a textstack-* locator lands only on a chapter of its file, checked
    // in the write itself so a re-extraction cannot slip between a check and the write.
    private const string CurrentChapterExists =
        "(CAST(@CurrentKey AS text) IS NULL OR EXISTS (SELECT FROM book_chapters c WHERE c.user_id = @userId AND c.file_id = @FileId AND c.chapter_key = @CurrentKey))";

    private const string FrontierChapterExists =
        "(CAST(@FrontierKey AS text) IS NULL OR EXISTS (SELECT FROM book_chapters c WHERE c.user_id = @userId AND c.file_id = @FileId AND c.chapter_key = @FrontierKey))";

    // A locator's scheme fits its file (#1122): pdf-page only on a PDF, epub-cfi on any other format, page-name only on a CBZ (#1188) or an EPUB (#1196);
    // textstack-* on any (its guard is the chapter check). SyncValidation.FitsFile names a loss to these.
    private const string CurrentFitsFile =
        "(CASE CAST(@CurrentLocator AS jsonb) ->> 'scheme' WHEN 'pdf-page' THEN f.format = 'pdf' WHEN 'epub-cfi' THEN f.format <> 'pdf' WHEN 'page-name' THEN f.format IN ('cbz', 'epub') ELSE true END)";

    private const string FrontierFitsFile =
        "(CASE CAST(@FrontierLocator AS jsonb) ->> 'scheme' WHEN 'pdf-page' THEN f.format = 'pdf' WHEN 'epub-cfi' THEN f.format <> 'pdf' WHEN 'page-name' THEN f.format IN ('cbz', 'epub') ELSE true END)";

    // A first write may only start on the book's current file; ON CONFLICT turns "someone wrote
    // first" into no row returned. Selecting the file by user also makes another user's ids a loss.
    private const string InsertFirstState = $"""
        INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision)
        SELECT f.user_id, f.book_id, f.id, CAST(@CurrentLocator AS jsonb), @BookFraction, CAST(@FrontierLocator AS jsonb), @FrontierFraction, @CompletedAt, @ClientRecordedAt, now(), 1
        FROM book_files f
        WHERE f.user_id = @userId AND f.book_id = @bookId AND f.id = @FileId AND f.is_current
            AND {CurrentFitsFile} AND {FrontierFitsFile}
            AND {CurrentChapterExists} AND {FrontierChapterExists}
        -- Waits for a replacement in flight, then re-checks is_current: no state lands on a superseded file.
        FOR SHARE OF f
        ON CONFLICT (user_id, book_id) DO NOTHING
        RETURNING {Columns}
        """;

    // The frontier moves only forward, locator with fraction. A row with no frontier yet takes
    // the offered one. Completion, like the frontier, is undone only by a reset.
    private const string AdvanceGuarded = $"""
        UPDATE reading_state SET
            current_locator = CAST(@CurrentLocator AS jsonb),
            book_fraction = @BookFraction,
            frontier_locator = CASE WHEN frontier_fraction IS NULL OR @FrontierFraction > frontier_fraction
                                    THEN CAST(@FrontierLocator AS jsonb) ELSE frontier_locator END,
            frontier_fraction = GREATEST(frontier_fraction, @FrontierFraction),
            completed_at = COALESCE(completed_at, @CompletedAt),
            client_recorded_at = @ClientRecordedAt,
            updated_at = now(),
            revision = revision + 1
        WHERE user_id = @userId AND book_id = @bookId AND file_id = @FileId AND revision = @expectedRevision
            -- The file's format, read by key in the same statement; the frontier's scheme only when this write stores it.
            AND EXISTS (SELECT FROM book_files f WHERE f.user_id = @userId AND f.id = @FileId
                AND {CurrentFitsFile} AND (frontier_fraction IS NOT NULL AND @FrontierFraction <= frontier_fraction OR {FrontierFitsFile}))
            -- The frontier's chapter only when this write stores it: an unchanged one echoed back is not refused.
            AND {CurrentChapterExists}
            AND (frontier_fraction IS NOT NULL AND @FrontierFraction <= frontier_fraction OR {FrontierChapterExists})
        RETURNING {Columns}
        """;

    public async Task<RevisionedWrite<ReadingState>> AdvanceAsync(
        Guid userId, Guid bookId, ReadingState state, long? expectedRevision, TransitionalChapterKeys chapters, CancellationToken ct)
    {
        var (frontierLocator, frontierFraction) = ReadingState.Furthest(
            (state.FrontierLocator, state.FrontierFraction), (state.CurrentLocator, state.BookFraction));
        var args = new
        {
            userId,
            bookId,
            expectedRevision,
            state.FileId,
            state.CurrentLocator,
            state.BookFraction,
            FrontierLocator = frontierLocator,
            FrontierFraction = frontierFraction,
            state.CompletedAt,
            state.ClientRecordedAt,
            CurrentKey = chapters.Current,
            FrontierKey = chapters.Frontier,
        };
        await using (var conn = await dataSource.OpenConnectionAsync(ct))
        {
            var written = await conn.QuerySingleOrDefaultAsync<ReadingState>(new CommandDefinition(
                expectedRevision is null ? InsertFirstState : AdvanceGuarded, args, cancellationToken: ct));
            if (written is not null) return new RevisionedWrite<ReadingState>(true, written);
        }
        return new RevisionedWrite<ReadingState>(false, await GetAsync(userId, bookId, ct));
    }

    // An update, not a delete: a deleted row would let the next first write start at revision 1
    // again, and a stale device holding revision 1 would then win and undo the reset. Both
    // columns read the old revision, so reset_revision = revision after this. Guarded like a
    // write (M1.2 delta 2a): a replayed reset after another device moved on must not reset again.
    private const string ResetFrontier = $"""
        UPDATE reading_state SET
            frontier_locator = NULL,
            frontier_fraction = NULL,
            completed_at = NULL,
            updated_at = now(),
            revision = revision + 1,
            reset_revision = revision + 1
        WHERE user_id = @userId AND book_id = @bookId AND revision = @expectedRevision
        RETURNING {Columns}
        """;

    public async Task<RevisionedWrite<ReadingState>> ResetAsync(Guid userId, Guid bookId, long expectedRevision, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var reset = await conn.QuerySingleOrDefaultAsync<ReadingState>(
            new CommandDefinition(ResetFrontier, new { userId, bookId, expectedRevision }, cancellationToken: ct));
        // The re-read is its own statement: in the reset's snapshot a loss to a concurrent writer would show the row before the winner.
        return reset is not null ? new(true, reset)
            : new(false, await conn.QuerySingleOrDefaultAsync<ReadingState>(new CommandDefinition(SelectState, new { userId, bookId }, cancellationToken: ct)));
    }

    // The state's locators and fractions mean something only in the version they were taken in.
    // A delete is safe here, unlike in a reset: a device still holding the old revision names the
    // old file, and AdvanceAsync's file_id guard makes that write lose.
    private const string DeleteStateOfFile = "DELETE FROM reading_state WHERE user_id = @userId AND book_id = @bookId AND file_id = @fileId";

    public async Task<bool> DeleteForFileAsync(Guid userId, Guid bookId, Guid fileId, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var lease = await dataSource.JoinOrOpenAsync(tx, ct);
        return await lease.Connection.ExecuteAsync(
            new CommandDefinition(DeleteStateOfFile, new { userId, bookId, fileId }, tx, cancellationToken: ct)) > 0;
    }

    private const string SelectChanged = $"""
        SELECT {Columns} FROM reading_state
        WHERE user_id = @userId AND (updated_at, book_id) > (@since, @afterId)
        ORDER BY updated_at, book_id
        LIMIT @limit
        """;

    public async Task<IReadOnlyList<ReadingState>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterBookId, int limit, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<ReadingState>(new CommandDefinition(
            SelectChanged, new { userId, since, afterId = afterBookId, limit }, cancellationToken: ct))).AsList();
    }
}
