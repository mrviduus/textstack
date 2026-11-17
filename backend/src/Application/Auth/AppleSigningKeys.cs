using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

/// <summary>
/// Apple's identity-token signing keys (JWKS), cached process-wide. Refetched for a key id the cache does
/// not hold, or once the keys are older than <see cref="MaxAge"/>, at most once per
/// <see cref="MinRefreshInterval"/>. A failed fetch, or one with no usable keys, keeps the cached keys.
/// </summary>
public sealed class AppleSigningKeys(Func<CancellationToken, Task<string>> fetchJwks, TimeProvider? clock = null)
{
    public const string JwksUrl = "https://appleid.apple.com/auth/keys";
    public static readonly TimeSpan MinRefreshInterval = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    public static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);

    private static readonly HttpClient Http = new();

    /// <summary>The keys Apple publishes; shared so every verifier, legacy or V2, uses one cache.</summary>
    public static AppleSigningKeys Shared { get; } = new(ct => Http.GetStringAsync(JwksUrl, ct));

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IReadOnlyList<SecurityKey> _keys = [];
    private long? _fetchedAt;   // last fetch that produced keys (monotonic)
    private long? _attemptedAt; // last fetch attempt, finished (monotonic)

    public async Task<IReadOnlyList<SecurityKey>> GetAsync(string? keyId, ILogger? logger, CancellationToken ct)
    {
        if (Fresh(keyId)) return _keys;

        await _gate.WaitAsync(ct);
        try
        {
            if (!Fresh(keyId) && (_attemptedAt is not { } attempted || _clock.GetElapsedTime(attempted) >= MinRefreshInterval))
                await RefreshAsync(logger);
            return _keys;
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool Fresh(string? keyId) =>
        keyId is not null && _keys.Any(k => k.KeyId == keyId)
        && _fetchedAt is { } fetched && _clock.GetElapsedTime(fetched) < MaxAge;

    // Its own timeout, not the caller's token: one aborted request must not cost every other sign-in the cache.
    private async Task RefreshAsync(ILogger? logger)
    {
        try
        {
            using var timeout = new CancellationTokenSource(FetchTimeout, _clock);
            var keys = new JsonWebKeySet(await fetchJwks(timeout.Token)).GetSigningKeys();
            if (keys.Count == 0)
            {
                logger?.LogWarning("Apple signing keys: the key set had no usable keys; keeping {CachedKeys} cached keys", _keys.Count);
                return;
            }
            _keys = [.. keys];
            _fetchedAt = _clock.GetTimestamp();
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Apple signing keys: fetch failed; keeping {CachedKeys} cached keys", _keys.Count);
        }
        finally
        {
            _attemptedAt = _clock.GetTimestamp();
        }
    }
}
