using Application.Common;
using Application.Reading;
using Dapper;
using Domain.Reading;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IReadingSessionRepository"/> on <c>textstack_v2</c>. One row per
/// <c>(user_id, client_session_id)</c> (<c>ak_reading_sessions_user_id_client_session_id</c>); the book
/// must be the user's (<c>fk_reading_sessions_books_user_id_book_id</c>, immediate).
/// </summary>
public sealed class ReadingSessionRepository(AppDataSource dataSource) : IReadingSessionRepository
{
    private const string Columns =
        "id, user_id, client_session_id, book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at";

    // The no-op DO UPDATE returns the stored row when the client session id is taken; xmax = 0 only
    // on a row this statement inserted.
    private const string UpsertSession = $"""
        INSERT INTO reading_sessions (id, user_id, client_session_id, book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
        VALUES (gen_random_uuid(), @UserId, @ClientSessionId, @BookId, @StartedAt, @EndedAt, @DurationSeconds, @WordsRead, @StartPercent, @EndPercent, now())
        ON CONFLICT (user_id, client_session_id) DO UPDATE SET client_session_id = EXCLUDED.client_session_id
        RETURNING {Columns}, xmax = 0 AS inserted
        """;

    public async Task<WriteResult<ReadingSession>> SaveAsync(Guid userId, ReadingSession session, CancellationToken ct)
    {
        session.UserId = userId;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var (stored, inserted) = (await conn.QueryAsync<ReadingSession, bool, (ReadingSession, bool)>(
            new CommandDefinition(UpsertSession, session, cancellationToken: ct), (row, isNew) => (row, isNew), splitOn: "inserted")).Single();
        return new(inserted ? WriteOutcome.Created : WriteOutcome.Replayed, stored);
    }

    // ponytail: a session counts whole on the day it started (in the zone); one crossing midnight is not split.
    // All time, one row per day read: the streaks need every day, and a reader's days are a few thousand at most.
    // Today comes from the same clock and zone database as the days; a future session (a skewed device clock) waits for its time.
    private const string SelectDailyTotals = """
        SELECT (now() AT TIME ZONE @TimeZone)::date;
        SELECT (started_at AT TIME ZONE @TimeZone)::date AS day, sum(duration_seconds)::bigint AS seconds
        FROM reading_sessions
        WHERE user_id = @UserId AND duration_seconds > 0 AND started_at <= now()
        GROUP BY 1
        ORDER BY 1;
        """;

    public async Task<DailyTotals?> DailyTotalsAsync(Guid userId, string timeZone, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        try
        {
            await using var grid = await conn.QueryMultipleAsync(
                new CommandDefinition(SelectDailyTotals, new { UserId = userId, TimeZone = timeZone }, cancellationToken: ct));
            // Npgsql reads a date as DateOnly.
            var today = await grid.ReadSingleAsync<DateOnly>();
            var days = await grid.ReadAsync<(DateOnly Day, long Seconds)>();
            return new(today, [.. days.Select(d => new DailyReading(d.Day, d.Seconds))]);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.InvalidParameterValue)
        {
            return null; // time zone "…" not recognized
        }
    }
}
