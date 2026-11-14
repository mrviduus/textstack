using Application.Identity;
using Application.Reading;
using Application.ReadingTracking;

namespace Api.V2;

/// <summary>
/// The V2 reader's sessions for the legacy pace (#1313). Legacy never depends on V2: with <c>Features:V2Api</c>
/// off, V2 not ready (<see cref="V2Readiness"/>'s answer, awaited within the same bound), or the query failing or
/// slower than <see cref="Timeout"/>, the answer is no sessions, logged at Warning. A query that failed or timed
/// out drops the readiness cache (the next caller checks again; a hanging V2 then answers Unreachable for its TTL);
/// a bound spent waiting on the readiness check leaves it alone, since that check caches its own answer. Only the
/// caller's own cancellation is thrown.
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
            // Added to legacy's own sessions (ReadingPace), so the rows the ETL carried from legacy are left out:
            // legacy counts them already. Transitional: goes at M6, when legacy's sessions are retired.
            return await sessions.PaceTotalsAsync(userId, excludeEtlCarried: true, bounded.Token);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            // Our own bound (Npgsql's cancel included) is an outage as much as a connection error.
            if (e is OperationCanceledException) readiness.Invalidate();
            else readiness.Observe(e);
            logger.LogWarning(e, "V2 sessions not counted in the pace of {UserId}", userId);
            return default;
        }
    }
}
