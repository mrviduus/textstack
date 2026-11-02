using Application.Common;
using Application.Reading;
using Dapper;
using Domain.Reading;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IReadingSessionRepository"/> on <c>textstack_v2</c>. One row per
/// <c>(user_id, client_session_id)</c> (<c>ak_reading_sessions_user_id_client_session_id</c>); the book
/// must be the user's (<c>fk_reading_sessions_books_user_id_book_id</c>, immediate).
/// </summary>
public sealed class ReadingSessionRepository(V2DataSource dataSource) : IReadingSessionRepository
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
}
