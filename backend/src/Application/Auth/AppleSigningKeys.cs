using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

/// <summary>
/// Apple's identity-token signing keys (JWKS), cached process-wide. Refetched only for a key id the cache
/// does not hold, at most once per <see cref="MinRefreshInterval"/>; a failed fetch keeps the old keys.
/// </summary>
public sealed class AppleSigningKeys(Func<CancellationToken, Task<string>> fetchJwks, TimeProvider? clock = null)
{
    public const string JwksUrl = "https://appleid.apple.com/auth/keys";
    public static readonly TimeSpan MinRefreshInterval = TimeSpan.FromMinutes(1);

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>The keys Apple publishes; shared so every verifier, legacy or V2, uses one cache.</summary>
    public static AppleSigningKeys Default { get; } = new(ct => Http.GetStringAsync(JwksUrl, ct));

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private IReadOnlyList<SecurityKey> _keys = [];
    private DateTimeOffset? _lastFetch;

    public async Task<IReadOnlyList<SecurityKey>> GetAsync(string? keyId, CancellationToken ct)
    {
        if (Holds(keyId)) return _keys;

        await _gate.WaitAsync(ct);
        try
        {
            var now = _clock.GetUtcNow();
            if (!Holds(keyId) && (_lastFetch is null || now - _lastFetch >= MinRefreshInterval))
            {
                _lastFetch = now;
                try
                {
                    _keys = [.. new JsonWebKeySet(await fetchJwks(ct)).GetSigningKeys()];
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    // Apple unreachable or a bad document: keep the old keys; the token is refused if none match.
                }
            }
            return _keys;
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool Holds(string? keyId) => keyId is not null && _keys.Any(k => k.KeyId == keyId);
}
