using Api.Extensions;
using Infrastructure.Persistence;

namespace Api.V2;

/// <summary>What <see cref="V2Readiness"/> found: <c>/me/v2/*</c> serves only when <see cref="IsReady"/>.</summary>
public sealed record V2State(string Status, IReadOnlyList<string>? Pending = null, string? Error = null)
{
    public const string Ready = "ok";
    public const string Behind = "behind";
    public const string Unreachable = "unreachable";
    public const string Unconfigured = "unconfigured";

    public bool IsReady => Status == Ready;
}

/// <summary>
/// Is <c>textstack_v2</c> there and migrated to this build (#1053)? Read by the V2 endpoint filter and
/// by <c>/health/ready</c>'s soft <c>v2</c> component, never at startup: if this fails at 03:00 only
/// sync pauses (docs/incidents/2026-10-30-migrator-v2-took-down-the-api.md). The answer is cached
/// for <see cref="Ttl"/>, so neither a burst of requests nor the probe opens a V2 connection each;
/// concurrent callers share one check. Without <c>ConnectionStrings:V2</c> it answers
/// <see cref="V2State.Unconfigured"/> without touching <see cref="V2DataSource"/>.
/// </summary>
public sealed class V2Readiness(IConfiguration config, IServiceProvider services, TimeProvider clock, ILogger<V2Readiness> logger)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

    // A cap on one check, whatever the connection string's own timeouts say: the probe must not hang.
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(5);

    private sealed record Cached(Lazy<Task<V2State>> Check, DateTimeOffset At);

    private Cached? _cached;

    public Task<V2State> GetAsync()
    {
        var now = clock.GetUtcNow();
        var cached = Volatile.Read(ref _cached);
        if (cached is not null && now - cached.At < Ttl) return cached.Check.Value;
        var fresh = new Cached(new Lazy<Task<V2State>>(CheckAsync), now);
        // Of two callers that both saw it expire, one check runs; the other awaits the winner's.
        var winner = Interlocked.CompareExchange(ref _cached, fresh, cached) == cached ? fresh : Volatile.Read(ref _cached)!;
        return winner.Check.Value;
    }

    private async Task<V2State> CheckAsync()
    {
        if (string.IsNullOrWhiteSpace(config.GetConnectionString("V2")))
            return new V2State(V2State.Unconfigured);
        try
        {
            using var timeout = new CancellationTokenSource(CheckTimeout);
            await using var conn = await services.GetRequiredService<V2DataSource>().OpenConnectionAsync(timeout.Token);
            var pending = await SchemaVersion.V2PendingAsync(conn, timeout.Token);
            if (pending.Count == 0) return new V2State(V2State.Ready);
            logger.LogWarning("textstack_v2 is behind this build: {PendingCount} pending, newest {NewestPending}; /me/v2 answers 503",
                pending.Count, pending[^1]);
            return new V2State(V2State.Behind, pending);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "textstack_v2 is unreachable; /me/v2 answers 503");
            return new V2State(V2State.Unreachable, Error: ex.GetType().Name);
        }
    }
}
