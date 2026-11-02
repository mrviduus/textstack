using System.Text.Json.Serialization;
using Api.Extensions;
using Infrastructure.Persistence;

namespace Api.V2;

/// <summary>What <see cref="V2Readiness"/> found: <c>/me/v2/*</c> serves only when <see cref="IsReady"/>. Also <c>/health/ready</c>'s <c>v2</c> component, as is.</summary>
public sealed record V2State(
    string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Pending = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error = null)
{
    public const string Ready = "ok";
    public const string Behind = "behind";
    public const string Unreachable = "unreachable";
    public const string Unconfigured = "unconfigured";

    [JsonIgnore]
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
public sealed class V2Readiness
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

    // ponytail: the cache answers for up to Ttl after V2 changes: measured, a `down 0` gives 500s for
    // up to 30 s before the 503, and an `up` 503s for up to 30 s more. Upgrade: drop the cache when a
    // /me/v2 handler sees a V2 PostgresException.

    /// <summary>A cap on one check, whatever the connection string's own timeouts say: the probe must not hang.</summary>
    public static readonly TimeSpan DefaultCheckTimeout = TimeSpan.FromSeconds(5);

    private readonly TimeProvider _clock;
    private readonly ILogger<V2Readiness> _logger;
    private readonly bool _configured;
    private readonly Func<CancellationToken, Task<List<string>>> _readPending;
    private readonly TimeSpan _checkTimeout;

    public V2Readiness(IConfiguration config, IServiceProvider services, TimeProvider clock, ILogger<V2Readiness> logger)
        : this(clock, logger, !string.IsNullOrWhiteSpace(config.GetConnectionString("V2")), async ct =>
        {
            await using var conn = await services.GetRequiredService<V2DataSource>().OpenConnectionAsync(ct);
            return await SchemaVersion.V2PendingAsync(conn, ct);
        }, DefaultCheckTimeout)
    {
    }

    /// <param name="readPending">The V2 ledger's pending migrations; it must honour its token.</param>
    internal V2Readiness(TimeProvider clock, ILogger<V2Readiness> logger, bool configured,
        Func<CancellationToken, Task<List<string>>> readPending, TimeSpan checkTimeout) =>
        (_clock, _logger, _configured, _readPending, _checkTimeout) = (clock, logger, configured, readPending, checkTimeout);

    private sealed record Cached(Lazy<Task<V2State>> Check, DateTimeOffset At);

    private Cached? _cached;

    public Task<V2State> GetAsync()
    {
        var now = _clock.GetUtcNow();
        var cached = Volatile.Read(ref _cached);
        if (cached is not null && now - cached.At < Ttl) return cached.Check.Value;
        var fresh = new Cached(new Lazy<Task<V2State>>(CheckAsync), now);
        // Of two callers that both saw it expire, one check runs; the other awaits the winner's.
        var winner = Interlocked.CompareExchange(ref _cached, fresh, cached) == cached ? fresh : Volatile.Read(ref _cached)!;
        return winner.Check.Value;
    }

    private async Task<V2State> CheckAsync()
    {
        if (!_configured) return new V2State(V2State.Unconfigured);
        try
        {
            using var timeout = new CancellationTokenSource(_checkTimeout);
            var pending = await _readPending(timeout.Token);
            if (pending.Count == 0) return new V2State(V2State.Ready);
            _logger.LogWarning("textstack_v2 is behind this build: {PendingCount} pending, newest {NewestPending}; /me/v2 answers 503",
                pending.Count, pending[^1]);
            return new V2State(V2State.Behind, pending);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "textstack_v2 is unreachable; /me/v2 answers 503");
            return new V2State(V2State.Unreachable, Error: ex.GetType().Name);
        }
    }
}
