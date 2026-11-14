using Application.Identity;
using Application.Reading;
using Application.ReadingTracking;

namespace Api.V2;

/// <summary>
/// The V2 reader's sessions for the legacy pace (#1313). Legacy never depends on V2: with <c>Features:V2Api</c>
/// off, V2 not ready (<see cref="V2Readiness"/>'s answer, awaited within the same bound), or the query failing or
/// slower than <see cref="Timeout"/> (one limit for both, the query's waited out whether or not it honours its
/// token), the answer is no sessions, logged at Warning. A query out of time marks V2 unreachable for the readiness
/// TTL (the next calls answer at once); one that failed goes to <see cref="V2Readiness.Observe"/>; a limit spent
/// waiting on the readiness check leaves it alone, since that check caches its own answer. Only the caller's own
/// cancellation is thrown, and records nothing.
/// </summary>
public sealed class V2PaceTotals(IConfiguration config, V2Readiness readiness, IReadingSessionRepository sessions, ILogger<V2PaceTotals> logger) : IV2PaceTotals
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(2);

    public async Task<PaceTotals> GetAsync(Guid userId, CancellationToken ct)
    {
        if (!V2Follow.IsOn(config)) return default;
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bounded.CancelAfter(Timeout);
        V2State state;
        try
        {
            state = await readiness.GetAsync().WaitAsync(bounded.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("V2 sessions not counted in the pace of {UserId}: the V2 readiness check is still running", userId);
            return default;
        }
        if (!state.IsReady) return default;
        try
        {
            // Added to legacy's own sessions (ReadingPace): the sessions the V2 API wrote, not the ETL's copies.
            return await sessions.NativePaceTotalsAsync(userId, bounded.Token).WaitAsync(bounded.Token);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            // Out of our time (Npgsql's cancel included): V2 is slow or gone; the next calls skip it for the TTL.
            if (e is OperationCanceledException) readiness.ObserveTimeout();
            else readiness.Observe(e);
            logger.LogWarning(e, "V2 sessions not counted in the pace of {UserId}", userId);
            return default;
        }
    }
}
