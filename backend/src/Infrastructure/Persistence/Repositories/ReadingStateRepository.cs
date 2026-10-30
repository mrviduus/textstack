using Application.Reading;
using Dapper;
using Domain.Reading;

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
    private const string Columns =
        "file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision";

    private const string Select = $"SELECT {Columns} FROM reading_state WHERE user_id = @userId AND book_id = @bookId";

    public async Task<ReadingState?> GetAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<ReadingState>(
            new CommandDefinition(Select, new { userId, bookId }, cancellationToken: ct));
    }

    public async Task<AdvanceResult> AdvanceAsync(
        Guid userId, Guid bookId, ReadingState state, long? expectedRevision, CancellationToken ct)
    {
        // A first write may only start on the book's current file; ON CONFLICT turns "someone wrote
        // first" into no row returned. Selecting the file by user also makes another user's ids a loss.
        const string create = $"""
            INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision)
            SELECT f.user_id, f.book_id, f.id, CAST(@CurrentLocator AS jsonb), @BookFraction, CAST(@FrontierLocator AS jsonb), @FrontierFraction, @CompletedAt, @ClientRecordedAt, now(), 1
            FROM book_files f
            WHERE f.user_id = @userId AND f.book_id = @bookId AND f.id = @FileId AND f.is_current
            ON CONFLICT (user_id, book_id) DO NOTHING
            RETURNING {Columns}
            """;
        // The frontier moves only forward, locator with fraction. A row with no frontier yet takes
        // the offered one. Completion, like the frontier, is undone only by a reset.
        const string advance = $"""
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
            RETURNING {Columns}
            """;

        // The offered frontier is the further of the client's frontier and its position: a client
        // that sends none, or one behind its position, still never leaves the frontier trailing.
        var offerFrontier = state.FrontierFraction >= state.BookFraction;
        var args = new
        {
            userId,
            bookId,
            expectedRevision,
            state.FileId,
            state.CurrentLocator,
            state.BookFraction,
            FrontierLocator = offerFrontier ? state.FrontierLocator : state.CurrentLocator,
            FrontierFraction = offerFrontier ? state.FrontierFraction : state.BookFraction,
            state.CompletedAt,
            state.ClientRecordedAt,
        };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var written = await conn.QuerySingleOrDefaultAsync<ReadingState>(new CommandDefinition(
            expectedRevision is null ? create : advance, args, cancellationToken: ct));
        if (written is not null) return new AdvanceResult(true, written);

        var current = await conn.QuerySingleOrDefaultAsync<ReadingState>(
            new CommandDefinition(Select, new { userId, bookId }, cancellationToken: ct));
        return new AdvanceResult(false, current);
    }

    public async Task<bool> ResetAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = "DELETE FROM reading_state WHERE user_id = @userId AND book_id = @bookId";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct)) > 0;
    }
}
