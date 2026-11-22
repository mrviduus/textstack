using System.Text.Json.Serialization;
using Api.Extensions;
using Application.Common;
using Infrastructure.Persistence;
using Npgsql;

namespace Api.Sync;

/// <summary>What <see cref="SyncReadiness"/> found: <c>/me/v2/*</c> serves only when <see cref="IsReady"/>. Also <c>/health/ready</c>'s <c>v2</c> component, as is.</summary>
public sealed record ReadinessState(
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
/// sync pauses (docs/internal/incidents/2026-10-30-migrator-v2-took-down-the-api.md). The answer is cached
/// for <see cref="Ttl"/>, so neither a burst of requests nor the probe opens a V2 connection each;
/// concurrent callers share one check, and <see cref="Invalidate"/> drops it when a request saw V2 fail.
/// Without <c>ConnectionStrings:V2</c> it answers <see cref="ReadinessState.Unconfigured"/> without a connection.
/// </summary>
/// <param name="readPending">The V2 ledger's pending migrations (tests fake it); it must honour its token.</param>
/// <param name="checkTimeout">A cap on one check, whatever the connection string's own timeouts say: the probe must not hang.</param>
public sealed class SyncReadiness(
    AppDataSource v2, TimeProvider clock, ILogger<SyncReadiness> logger,
    Func<CancellationToken, Task<List<string>>>? readPending = null, TimeSpan? checkTimeout = null)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan DefaultCheckTimeout = TimeSpan.FromSeconds(5);

    private static readonly Task<ReadinessState> UnconfiguredState = Task.FromResult(new ReadinessState(ReadinessState.Unconfigured));

    private readonly Func<CancellationToken, Task<List<string>>> _readPending = readPending ?? (async ct =>
    {
        await using var conn = await v2.OpenConnectionAsync(ct);
        return await SchemaVersion.PendingAsync(conn, SchemaVersion.Known, ct);
    });

    private sealed record Cached(Lazy<Task<ReadinessState>> Check, DateTimeOffset At);

    private Cached? _cached;

    public Task<ReadinessState> GetAsync()
    {
        if (!v2.IsConfigured) return UnconfiguredState;
        var now = clock.GetUtcNow();
        var cached = Volatile.Read(ref _cached);
        if (cached is not null && now - cached.At < Ttl) return cached.Check.Value;
        var fresh = new Cached(new Lazy<Task<ReadinessState>>(CheckAsync), now);
        // Of two callers that both saw it expire, one check runs; the other awaits the winner's.
        var winner = Interlocked.CompareExchange(ref _cached, fresh, cached) == cached ? fresh : Volatile.Read(ref _cached)!;
        return winner.Check.Value;
    }

    /// <summary>The next caller checks again: a request just saw V2 fail, or V2 just came back.</summary>
    public void Invalidate() => Volatile.Write(ref _cached, null);

    /// <summary>
    /// A V2 call failed with <paramref name="error"/>: anything from the database or its connection
    /// that is not an answer about the data (a constraint, a deadlock, a serialization failure) may be
    /// an outage, so the next caller checks again.
    /// </summary>
    public void Observe(Exception error)
    {
        if (error is NpgsqlException && !error.IsIntegrityViolation() && !error.IsTransientConflict()) Invalidate();
    }

    private async Task<ReadinessState> CheckAsync()
    {
        try
        {
            using var timeout = new CancellationTokenSource(checkTimeout ?? DefaultCheckTimeout);
            var pending = await _readPending(timeout.Token);
            if (pending.Count == 0) return new ReadinessState(ReadinessState.Ready);
            logger.LogWarning("textstack_v2 is behind this build: {PendingCount} pending, newest {NewestPending}; /me/v2 answers 503",
                pending.Count, pending[^1]);
            return new ReadinessState(ReadinessState.Behind, pending);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "textstack_v2 is unreachable; /me/v2 answers 503");
            return new ReadinessState(ReadinessState.Unreachable, Error: ex.GetType().Name);
        }
    }
}
