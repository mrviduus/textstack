using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Auth;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests;

/// <summary>Apple identity tokens: only Apple-signed (RS256, published kid), Apple-issued, for this bundle id, unexpired.</summary>
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

    private static AppleSigningKeys Keys(Func<string> jwks, TimeProvider? clock = null) => new(_ => Task.FromResult(jwks()), clock);

    private static ProviderTokens Verifier(string? bundleId = BundleId, AppleSigningKeys? keys = null) =>
        new(apple: new AppleSettings { BundleId = bundleId! }, appleKeys: keys ?? Keys(() => Jwks(AppleKey)));

    private static string Token(SecurityKey? key = null, string algorithm = SecurityAlgorithms.RsaSha256,
        string issuer = ProviderTokens.AppleIssuer, string audience = BundleId, int expiresInMinutes = 5) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            Claims = new Dictionary<string, object> { ["sub"] = "apple-subject", ["email"] = "reader@privaterelay.appleid.com" },
            NotBefore = DateTime.UtcNow.AddMinutes(-30),
            IssuedAt = DateTime.UtcNow.AddMinutes(-30),
            Expires = DateTime.UtcNow.AddMinutes(expiresInMinutes),
            SigningCredentials = new SigningCredentials(key ?? AppleKey, algorithm),
        });

    [Fact]
    public async Task VerifyAppleAsync_SignedByApplesKey_ReturnsIdentity()
    {
        var apple = await Verifier().VerifyAppleAsync(Token(), Ct);

        Assert.Equal(("apple-subject", "reader@privaterelay.appleid.com"), (apple?.Subject, apple?.Email));
    }

    [Fact]
    public async Task VerifyAppleAsync_WrongSignature_Null()
    {
        Assert.Null(await Verifier().VerifyAppleAsync(Token(OtherKey), Ct));
    }

    [Fact]
    public async Task VerifyAppleAsync_TamperedPayload_Null()
    {
        var parts = Token().Split('.');
        var forged = Base64UrlEncoder.Encode(Encoding.UTF8.GetBytes(
            Base64UrlEncoder.Decode(parts[1]).Replace("apple-subject", "someone-else")));

        Assert.Null(await Verifier().VerifyAppleAsync($"{parts[0]}.{forged}.{parts[2]}", Ct));
    }

    [Fact]
    public async Task VerifyAppleAsync_AlgNone_Null()
    {
        var unsigned = new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = ProviderTokens.AppleIssuer,
            Audience = BundleId,
            Claims = new Dictionary<string, object> { ["sub"] = "apple-subject" },
            Expires = DateTime.UtcNow.AddMinutes(5),
        });

        Assert.Null(await Verifier().VerifyAppleAsync(unsigned, Ct));
    }

    [Fact]
    public async Task VerifyAppleAsync_Hs256_Null()
    {
        var hmac = new SymmetricSecurityKey(new byte[32]) { KeyId = Kid };

        Assert.Null(await Verifier().VerifyAppleAsync(Token(hmac, SecurityAlgorithms.HmacSha256), Ct));
    }

    [Theory]
    [InlineData("https://evil.example", BundleId, 5)]
    [InlineData(ProviderTokens.AppleIssuer, "another.app", 5)]
    [InlineData(ProviderTokens.AppleIssuer, BundleId, -5)]
    public async Task VerifyAppleAsync_WrongIssuerAudienceOrExpired_Null(string issuer, string audience, int expiresInMinutes)
    {
        Assert.Null(await Verifier().VerifyAppleAsync(Token(issuer: issuer, audience: audience, expiresInMinutes: expiresInMinutes), Ct));
    }

    [Fact]
    public async Task VerifyAppleAsync_UnknownKid_Null()
    {
        var stranger = new RsaSecurityKey(RSA.Create(2048)) { KeyId = "not-published" };

        Assert.Null(await Verifier().VerifyAppleAsync(Token(stranger), Ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task VerifyAppleAsync_NoBundleId_NullWithoutFetchingKeys(string? bundleId)
    {
        var fetches = 0;
        var keys = Keys(() => { fetches++; return Jwks(AppleKey); });

        Assert.Null(await Verifier(bundleId, keys).VerifyAppleAsync(Token(), Ct));
        Assert.Equal(0, fetches);
    }

    [Fact]
    public async Task VerifyAppleAsync_NotAJwt_Null()
    {
        Assert.Null(await Verifier().VerifyAppleAsync("not a jwt", Ct));
    }

    [Fact]
    public async Task GetAsync_KnownKid_FetchesOnce()
    {
        var fetches = 0;
        var keys = Keys(() => { fetches++; return Jwks(AppleKey); });

        await keys.GetAsync(Kid, Ct);
        await keys.GetAsync(Kid, Ct);

        Assert.Equal(1, fetches);
    }

    [Fact]
    public async Task GetAsync_UnknownKid_RefetchesAtMostOncePerInterval()
    {
        var clock = new SteppedClock();
        var fetches = 0;
        var keys = Keys(() => { fetches++; return Jwks(AppleKey); }, clock);

        await keys.GetAsync("rotated", Ct);
        await keys.GetAsync("rotated", Ct);
        clock.Now += AppleSigningKeys.MinRefreshInterval;
        await keys.GetAsync("rotated", Ct);

        Assert.Equal(2, fetches);
    }

    [Fact]
    public async Task GetAsync_FetchFails_KeepsCachedKeys()
    {
        var clock = new SteppedClock();
        var fail = false;
        var keys = Keys(() => fail ? throw new HttpRequestException("down") : Jwks(AppleKey), clock);
        await keys.GetAsync(Kid, Ct);

        fail = true;
        clock.Now += AppleSigningKeys.MinRefreshInterval;

        Assert.Equal(Kid, Assert.Single(await keys.GetAsync("rotated", Ct)).KeyId);
    }
}
