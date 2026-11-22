using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Auth;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A reader signs in with Apple: only an Apple-signed (RS256, published kid), Apple-issued, unexpired token for this
/// bundle id names them, and Apple's keys are cached so a slow or broken key endpoint never locks everyone out at once.
/// </summary>
public class AppleIdentityTokenTests
{
    private const string BundleId = "app.textstack.mobile";
    private const string Kid = "apple-test-key";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly RsaSecurityKey AppleKey = new(RSA.Create(2048)) { KeyId = Kid };
    private static readonly RsaSecurityKey OtherKey = new(RSA.Create(2048)) { KeyId = Kid };

    private static string Jwks(RsaSecurityKey key)
    {
        var p = key.Rsa.ExportParameters(false);
        return JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new { kty = "RSA", kid = key.KeyId, use = "sig", alg = "RS256", n = Base64UrlEncoder.Encode(p.Modulus), e = Base64UrlEncoder.Encode(p.Exponent) },
            },
        });
    }

    /// <summary>A clock a test moves by hand, wall and monotonic time together.</summary>
    private sealed class MonotonicClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;

        public void Advance(TimeSpan by) => _now += by;

        public override DateTimeOffset GetUtcNow() => _now;

        public override long GetTimestamp() => _now.UtcTicks;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    }

    private static AppleSigningKeys Keys(Func<string> jwks, TimeProvider? clock = null) => new(_ => Task.FromResult(jwks()), clock);

    private static ProviderTokens Verifier(string? bundleId = BundleId, AppleSigningKeys? keys = null, CapturingLogger<ProviderTokens>? logger = null) =>
        new(apple: new AppleSettings { BundleId = bundleId! }, appleKeys: keys ?? Keys(() => Jwks(AppleKey)), logger: logger);

    private static string Token(SecurityKey? key = null, string algorithm = SecurityAlgorithms.RsaSha256,
        string issuer = ProviderTokens.AppleIssuer, string audience = BundleId, int expiresInMinutes = 5, object? emailVerified = null) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            Claims = emailVerified is "absent"
                ? new Dictionary<string, object> { ["sub"] = "apple-subject", ["email"] = "reader@privaterelay.appleid.com" }
                : new Dictionary<string, object> { ["sub"] = "apple-subject", ["email"] = "reader@privaterelay.appleid.com", ["email_verified"] = emailVerified ?? "true" },
            NotBefore = DateTime.UtcNow.AddMinutes(-30),
            IssuedAt = DateTime.UtcNow.AddMinutes(-30),
            Expires = DateTime.UtcNow.AddMinutes(expiresInMinutes),
            SigningCredentials = new SigningCredentials(key ?? AppleKey, algorithm),
        });

    private static string Tampered()
    {
        var parts = Token().Split('.');
        var forged = Base64UrlEncoder.Encode(Encoding.UTF8.GetBytes(
            Base64UrlEncoder.Decode(parts[1]).Replace("apple-subject", "someone-else")));
        return $"{parts[0]}.{forged}.{parts[2]}";
    }

    private static string Unsigned() => new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
    {
        Issuer = ProviderTokens.AppleIssuer,
        Audience = BundleId,
        Claims = new Dictionary<string, object> { ["sub"] = "apple-subject" },
        Expires = DateTime.UtcNow.AddMinutes(5),
    });

    private static readonly Dictionary<string, Func<string>> Refused = new()
    {
        ["signed by another key under Apple's kid"] = () => Token(OtherKey),
        ["payload tampered after signing"] = Tampered,
        ["alg none"] = Unsigned,
        ["HS256 under Apple's kid"] = () => Token(new SymmetricSecurityKey(new byte[32]) { KeyId = Kid }, SecurityAlgorithms.HmacSha256),
        ["kid Apple never published"] = () => Token(new RsaSecurityKey(RSA.Create(2048)) { KeyId = "not-published" }),
        ["another issuer"] = () => Token(issuer: "https://evil.example"),
        ["another app's audience"] = () => Token(audience: "another.app"),
        ["expired"] = () => Token(expiresInMinutes: -5),
    };

    [Theory]
    [InlineData(true, "reader@privaterelay.appleid.com")]
    [InlineData("true", "reader@privaterelay.appleid.com")]
    [InlineData(false, null)]
    [InlineData("false", null)]
    [InlineData("absent", null)]
    public async Task VerifyAppleAsync_SignedByApplesKey_NamesTheReaderWithTheEmailOnlyWhenVerified(object emailVerified, string? expected)
    {
        var apple = await Verifier().VerifyAppleAsync(Token(emailVerified: emailVerified), Ct);

        Assert.Equal(("apple-subject", expected), (apple?.Subject, apple?.Email));
    }

    [Theory]
    [InlineData("signed by another key under Apple's kid", "SecurityTokenInvalidSignatureException")]
    [InlineData("payload tampered after signing", "SecurityTokenInvalidSignatureException")]
    [InlineData("alg none", "SecurityTokenInvalidSignatureException")]
    [InlineData("HS256 under Apple's kid", "SecurityTokenInvalidSignatureException")]
    [InlineData("kid Apple never published", "SecurityTokenSignatureKeyNotFoundException")]
    [InlineData("another issuer", "SecurityTokenInvalidIssuerException")]
    [InlineData("another app's audience", "SecurityTokenInvalidAudienceException")]
    [InlineData("expired", "SecurityTokenExpiredException")]
    public async Task VerifyAppleAsync_ForgedOrMisaddressedToken_RefusedForThatReason(string token, string reason)
    {
        var logger = new CapturingLogger<ProviderTokens>();

        Assert.Null(await Verifier(logger: logger).VerifyAppleAsync(Refused[token](), Ct));
        Assert.Equal($"Apple sign-in refused: {reason}", Assert.Single(logger.Entries).Message);
    }

    // Unreadable input is a refusal, never an exception a caller would turn into a 500.
    [Theory]
    [InlineData("not a jwt", "unreadable identity token")]
    [InlineData("", "unreadable identity token")]
    [InlineData("!!!.@@@.###", "unreadable identity token")]
    [InlineData("a.b.c.d.e", "unreadable identity token")]
    [InlineData("!!!.@@@.###.$$$.%%%", "unreadable identity token")]
    [InlineData("eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.!!!.###.$$$.%%%", "unreadable identity token")]
    [InlineData("eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.YQ.YQ.YQ.YQ", "encrypted identity token")]
    public async Task VerifyAppleAsync_MalformedOrEncryptedToken_RefusedNotAnError(string identityToken, string reason)
    {
        var logger = new CapturingLogger<ProviderTokens>();

        Assert.Null(await Verifier(logger: logger).VerifyAppleAsync(identityToken, Ct));
        Assert.Contains(reason, Assert.Single(logger.Entries).Message);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task VerifyAppleAsync_NoBundleIdConfigured_RefusedWithoutFetchingKeys(string? bundleId)
    {
        var fetches = 0;
        var keys = Keys(() => { fetches++; return Jwks(AppleKey); });

        Assert.Null(await Verifier(bundleId, keys).VerifyAppleAsync(Token(), Ct));
        Assert.Equal(0, fetches);
    }

    [Fact]
    public async Task GetAsync_KnownKid_FetchedOnceThenAgainOnlyPastMaxAge()
    {
        var clock = new MonotonicClock();
        var fetches = 0;
        var keys = Keys(() => { fetches++; return Jwks(AppleKey); }, clock);

        await keys.GetAsync(Kid, null, Ct);
        await keys.GetAsync(Kid, null, Ct);
        Assert.Equal(1, fetches);

        clock.Advance(AppleSigningKeys.MaxAge);
        await keys.GetAsync(Kid, null, Ct);
        Assert.Equal(2, fetches);
    }

    // A rotated kid (the fetch answers) and an empty cache whose fetch fails: neither hammers Apple.
    [Theory]
    [InlineData("rotated", false)]
    [InlineData(Kid, true)]
    public async Task GetAsync_KeyMissingFromTheCache_RefetchedAtMostOncePerInterval(string kid, bool fetchFails)
    {
        var clock = new MonotonicClock();
        var fetches = 0;
        var keys = Keys(() => { fetches++; return fetchFails ? throw new HttpRequestException("down") : Jwks(AppleKey); }, clock);

        var first = await keys.GetAsync(kid, null, Ct);
        await keys.GetAsync(kid, null, Ct);
        Assert.Equal(1, fetches);
        Assert.Equal(fetchFails ? 0 : 1, first.Count);

        clock.Advance(AppleSigningKeys.MinRefreshInterval);
        await keys.GetAsync(kid, null, Ct);
        Assert.Equal(2, fetches);
    }

    // A thrown fetch and a key set with no usable keys are both failures: the cache is kept, but not forever.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task GetAsync_RefreshFails_KeepsCachedKeysUntilMaxStaleness(bool fetchThrows)
    {
        var clock = new MonotonicClock();
        var failing = false;
        var keys = Keys(() => !failing ? Jwks(AppleKey) : fetchThrows ? throw new HttpRequestException("down") : """{"keys":[]}""", clock);
        await keys.GetAsync(Kid, null, Ct);

        failing = true;
        clock.Advance(AppleSigningKeys.MinRefreshInterval);
        Assert.Equal(Kid, Assert.Single(await keys.GetAsync("rotated", null, Ct)).KeyId);

        clock.Advance(AppleSigningKeys.MaxAge);
        Assert.Equal(Kid, Assert.Single(await keys.GetAsync(Kid, null, Ct)).KeyId);

        clock.Advance(AppleSigningKeys.MaxStaleness);
        Assert.Empty(await keys.GetAsync(Kid, null, Ct));
    }

    [Fact]
    public async Task GetAsync_StaleKeysWhileRefreshing_OthersUseCachedKeysWithoutWaiting()
    {
        var clock = new MonotonicClock();
        var release = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var fetches = 0;
        var keys = new AppleSigningKeys(_ => ++fetches == 1 ? Task.FromResult(Jwks(AppleKey)) : release.Task, clock);
        await keys.GetAsync(Kid, null, Ct);
        clock.Advance(AppleSigningKeys.MaxAge);

        var refreshing = keys.GetAsync(Kid, null, Ct);
        var other = await keys.GetAsync(Kid, null, Ct);

        Assert.Equal(Kid, Assert.Single(other).KeyId);
        Assert.False(refreshing.IsCompleted);
        release.SetResult(Jwks(AppleKey));
        Assert.Single(await refreshing);
        Assert.Equal(2, fetches);
    }

    [Fact]
    public async Task GetAsync_CallerCancelsAfterwards_FetchUsedItsOwnToken()
    {
        using var caller = new CancellationTokenSource();
        CancellationToken fetchToken = default;
        var keys = new AppleSigningKeys(t => { fetchToken = t; return Task.FromResult(Jwks(AppleKey)); });

        await keys.GetAsync(Kid, null, caller.Token);
        caller.Cancel();

        Assert.True(fetchToken.CanBeCanceled);
        Assert.False(fetchToken.IsCancellationRequested);
    }
}
