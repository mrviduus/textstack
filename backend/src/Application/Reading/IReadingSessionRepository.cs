using Application.Common;
using Application.Reading;
using Domain.Reading;

namespace Application.Reading;

/// <summary>
/// The V2 reading sessions (table <c>reading_sessions</c>, ADR-031): pushed by readers, read back only as daily totals (stats, #1366). Scoped to
/// <c>userId</c> (docs/architecture/data-access.md rule 7).
/// </summary>
public interface IReadingSessionRepository
{
    /// <summary>
    /// Stores <paramref name="session"/> under <paramref name="userId"/> unless its
    /// <c>ClientSessionId</c> is already the user's: first write wins, so a replay — whatever its
    /// payload — is <see cref="WriteOutcome.Replayed"/> with the stored row. A <c>BookId</c> that is
    /// not the user's throws (a <c>PostgresException</c>); callers check it first.
    /// </summary>
    Task<WriteResult<ReadingSession>> SaveAsync(Guid userId, ReadingSession session, CancellationToken ct);

    /// <summary>
    /// Today in <paramref name="timeZone"/> (an IANA id, read by Postgres) and the user's seconds read per day there, over
    /// all time up to now, ascending; only days with time read. Sessions of a deleted book count. Null: Postgres knows no such zone.
    /// </summary>
    Task<DailyTotals?> DailyTotalsAsync(Guid userId, string timeZone, CancellationToken ct);
}

/// <summary>The database's today in the zone, and the days read (<see cref="DailyReading.Seconds"/> &gt; 0).</summary>
public sealed record DailyTotals(DateOnly Today, IReadOnlyList<DailyReading> Days);

public readonly record struct DailyReading(DateOnly Day, long Seconds);
