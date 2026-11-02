using Application.Common;
using Domain.Reading;

namespace Application.Reading;

/// <summary>
/// The V2 reading sessions (table <c>reading_sessions</c>, ADR-031), push only. Scoped to
/// <c>userId</c> (docs/01-architecture/data-access.md rule 7).
/// </summary>
public interface IReadingSessionRepository
{
    /// <summary>
    /// Stores <paramref name="session"/> under <paramref name="userId"/> unless its
    /// <c>ClientSessionId</c> is already the user's: first write wins, so a replay — whatever its
    /// payload — is <see cref="WriteOutcome.Replayed"/> with the stored row. A <c>BookId</c> that is
    /// not the user's is refused by the schema (a <c>PostgresException</c>): the caller checks it first.
    /// </summary>
    Task<WriteResult<ReadingSession>> SaveAsync(Guid userId, ReadingSession session, CancellationToken ct);
}
