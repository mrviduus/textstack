using Application.Common;
using Application.ReadingTracking;
using Domain.Reading;

namespace Application.Reading;

/// <summary>
/// The V2 reading sessions (table <c>reading_sessions</c>, ADR-031), push only. Scoped to
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
    /// The pace rule's totals over the user's sessions with words and seconds (#1313). <paramref name="excludeEtlCarried"/>:
    /// without the rows the ETL carried from legacy (<c>id = client_session_id</c>, EtlV2Sessions), for a sum with
    /// legacy's own (transitional, until M6).
    /// </summary>
    Task<PaceTotals> PaceTotalsAsync(Guid userId, bool excludeEtlCarried, CancellationToken ct);
}
