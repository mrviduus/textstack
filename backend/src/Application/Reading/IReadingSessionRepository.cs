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
    /// The user's seconds read per day in <paramref name="timeZone"/> (an IANA id), over all time, ascending; only days
    /// with time read. Sessions of a deleted book count.
    /// </summary>
    Task<IReadOnlyList<DailyReading>> DailyTotalsAsync(Guid userId, string timeZone, CancellationToken ct);
}

/// <summary>One day's reading: <see cref="Seconds"/> &gt; 0.</summary>
public readonly record struct DailyReading(DateOnly Day, long Seconds);
