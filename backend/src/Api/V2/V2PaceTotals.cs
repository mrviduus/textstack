using Application.Identity;
using Application.Reading;
using Application.ReadingTracking;
using Npgsql;

namespace Api.V2;

/// <summary>
/// The V2 reader's sessions for the legacy pace (#1313). Legacy never depends on V2, and this stats path never
/// decides for others whether V2 is up: it does not read the shared <see cref="V2Readiness"/> (a read can probe)
/// nor write it beyond what every V2 caller does (<see cref="V2Readiness.Observe"/> on an <see cref="NpgsqlException"/>).
/// With <c>Features:V2Api</c> off the answer is none; otherwise the query runs within <see cref="Timeout"/> (waited
/// out whether or not it honours its token), and a timeout or any failure answers none and skips V2 here for
/// <see cref="SkipFor"/> (this singleton's own state), logged at Warning. Only the caller's own cancellation is
/// thrown, and it skips nothing.
/// </summary>
public sealed class V2PaceTotals(
    IConfiguration config, IReadingSessionRepository sessions, V2Readiness readiness, TimeProvider clock, ILogger<V2PaceTotals> logger) : IV2PaceTotals
{
    public static readonly TimeSpan SkipFor = TimeSpan.FromSeconds(30);

    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(2);

    private long _skipUntilTicks;

    public async Task<PaceTotals> GetAsync(Guid userId, CancellationToken ct)
    {
        if (!V2Follow.IsOn(config) || clock.GetUtcNow().UtcTicks < Interlocked.Read(ref _skipUntilTicks)) return default;
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bounded.CancelAfter(Timeout);
        try
        {
            // Added to legacy's own sessions (ReadingPace): the sessions the V2 API wrote, not the ETL's copies.
            return await sessions.NativePaceTotalsAsync(userId, bounded.Token).WaitAsync(bounded.Token);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            // As every V2 caller: Observe acts on an NpgsqlException only (a possible outage), never on anything else.
            readiness.Observe(e);
            Interlocked.Exchange(ref _skipUntilTicks, (clock.GetUtcNow() + SkipFor).UtcTicks);
            logger.LogWarning(e, "V2 sessions not counted in the pace of {UserId}; V2 skipped here for {SkipFor}", userId, SkipFor);
            return default;
        }
    }
}
