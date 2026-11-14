using Application.Identity;
using Application.Reading;
using Application.ReadingTracking;
using Npgsql;

namespace Api.V2;

/// <summary>
/// The V2 reader's sessions for the legacy pace (#1313). Legacy never depends on V2: with <c>Features:V2Api</c>
/// off, V2 not ready (<see cref="V2Readiness"/>'s cached answer) or the query failing or slower than
/// <see cref="Timeout"/>, the answer is no sessions (a failure logged at Warning, a V2 error dropping the
/// readiness cache). Only the caller's own cancellation is thrown.
/// </summary>
public sealed class V2PaceTotals(IConfiguration config, V2Readiness readiness, IReadingSessionRepository sessions, ILogger<V2PaceTotals> logger) : IV2PaceTotals
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(2);

    public async Task<PaceTotals> GetAsync(Guid userId, CancellationToken ct)
    {
        if (!V2Follow.IsOn(config) || !(await readiness.GetAsync()).IsReady) return default;
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bounded.CancelAfter(Timeout);
        try
        {
            return await sessions.PaceTotalsAsync(userId, bounded.Token);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            if (e is NpgsqlException) readiness.Observe(e);
            logger.LogWarning(e, "V2 sessions not counted in the pace of {UserId}", userId);
            return default;
        }
    }
}
