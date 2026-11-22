using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using Polly;

namespace Application.Identity;

/// <summary>
/// Apple's identity-token signing keys (JWKS), cached process-wide.
/// <list type="bullet">
/// <item>Unknown key id: refetched, at most once per <see cref="MinRefreshInterval"/>; callers wait for it.</item>
/// <item>Keys older than <see cref="MaxAge"/>: one caller refreshes, the rest keep using the cached keys.</item>
/// <item>A failed fetch, or one with no usable keys, keeps the cached keys, up to <see cref="MaxStaleness"/>;
/// past that no key is offered, so every Apple token is refused.</item>
/// </list>
/// </summary>
public sealed class AppleSigningKeys(Func<CancellationToken, Task<string>> fetchJwks, TimeProvider? clock = null)
{
    public const string JwksUrl = "https://appleid.apple.com/auth/keys";
    public static readonly TimeSpan MinRefreshInterval = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    public static readonly TimeSpan MaxStaleness = TimeSpan.FromDays(7);
    public static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);

    // A GET, so retrying is safe. Sized to fit inside FetchTimeout (3 x 3s attempts + short delays),
    // which still bounds the whole fetch; refresh-at-most-once-per-MinRefreshInterval is unchanged.
    private static readonly HttpClient Http = new(new ResilienceHandler(new ResiliencePipelineBuilder<HttpResponseMessage>()
        .AddRetry(new HttpRetryStrategyOptions { MaxRetryAttempts = 2, Delay = TimeSpan.FromMilliseconds(500) })
        .AddTimeout(TimeSpan.FromSeconds(3))
        .Build())
    { InnerHandler = new SocketsHttpHandler() });

    /// <summary>The keys Apple publishes; shared so every verifier, legacy or V2, uses one cache.</summary>
    public static AppleSigningKeys Shared { get; } = new(ct => Http.GetStringAsync(JwksUrl, ct));

    /// <summary>The keys and when they were fetched (monotonic timestamp), swapped as one.</summary>
    private sealed record Snapshot(IReadOnlyList<SecurityKey> Keys, long FetchedAt);

    private static readonly Snapshot Empty = new([], 0);

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Snapshot _snapshot = Empty;
    private long? _attemptedAt; // last finished fetch attempt (monotonic); read and written under _gate only

    public async Task<IReadOnlyList<SecurityKey>> GetAsync(string? keyId, ILogger? logger, CancellationToken ct)
    {
        var snapshot = Volatile.Read(ref _snapshot);
        if (Holds(snapshot, keyId))
        {
            if (Age(snapshot) < MaxAge) return snapshot.Keys;

            // Stale but usable: one caller refreshes, nobody queues behind it.
            if (_gate.Wait(0))
            {
                try { await RefreshIfAllowedAsync(keyId, logger); }
                finally { _gate.Release(); }
            }
        }
        else
        {
            // A key id the cache lacks: only a refresh can help, so wait for it.
            await _gate.WaitAsync(ct);
            try { await RefreshIfAllowedAsync(keyId, logger); }
            finally { _gate.Release(); }
        }

        snapshot = Volatile.Read(ref _snapshot);
        if (snapshot.Keys.Count > 0 && Age(snapshot) >= MaxStaleness)
        {
            logger?.LogError("Apple signing keys: no successful refresh for {Age}; Apple sign-in is refused", Age(snapshot));
            return [];
        }
        return snapshot.Keys;
    }

    private static bool Holds(Snapshot snapshot, string? keyId) => keyId is not null && snapshot.Keys.Any(k => k.KeyId == keyId);

    private TimeSpan Age(Snapshot snapshot) => _clock.GetElapsedTime(snapshot.FetchedAt);

    private async Task RefreshIfAllowedAsync(string? keyId, ILogger? logger)
    {
        var current = Volatile.Read(ref _snapshot);
        if (Holds(current, keyId) && Age(current) < MaxAge) return; // another caller just refreshed
        if (_attemptedAt is { } attempted && _clock.GetElapsedTime(attempted) < MinRefreshInterval) return;

        // Its own timeout, not the caller's token: one aborted request must not cost every other sign-in the cache.
        try
        {
            using var timeout = new CancellationTokenSource(FetchTimeout, _clock);
            var keys = new JsonWebKeySet(await fetchJwks(timeout.Token)).GetSigningKeys();
            if (keys.Count == 0)
                logger?.LogWarning("Apple signing keys: the key set had no usable keys; keeping {CachedKeys} cached keys", current.Keys.Count);
            else
                Volatile.Write(ref _snapshot, new Snapshot([.. keys], _clock.GetTimestamp()));
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Apple signing keys: fetch failed; keeping {CachedKeys} cached keys", current.Keys.Count);
        }
        finally
        {
            _attemptedAt = _clock.GetTimestamp();
        }
    }
}
