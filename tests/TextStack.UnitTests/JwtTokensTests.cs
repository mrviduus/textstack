using Microsoft.IdentityModel.Tokens;
using System.Security.Cryptography;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Application.Auth;
using Domain.Enums;
using Microsoft.Extensions.Options;

namespace TextStack.UnitTests;

/// <summary>The token code legacy <see cref="AuthService"/> and <c>V2AuthService</c> share.</summary>
public class JwtTokensTests
{
    private static JwtSettings Settings(string secret = TestTokens.Secret, int accessMinutes = 60) =>
        new() { SecretKey = secret, Issuer = TestTokens.Issuer, AccessTokenExpiryMinutes = accessMinutes, RefreshTokenExpiryDays = 30, GuestRefreshTokenExpiryDays = 7 };

    private static readonly JwtTokens Tokens = new(Settings());

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MintAccessToken_RoundTrip_TheUserAndItsGuestFlag(bool isGuest)
    {
        var id = Guid.NewGuid();

        Assert.Equal((id, isGuest), Tokens.ValidateAccessToken(Tokens.MintAccessToken(id, "reader@example.test", null, isGuest)));
    }

    [Fact]
    public void MintAccessToken_LegacyAuthService_ValidatesWhatJwtTokensMints()
    {
        var id = Guid.NewGuid();
        var legacy = new AuthService(null!, Options.Create(Settings()), Options.Create(new GoogleSettings { ClientId = "unused" }));

        Assert.Equal((id, true), legacy.ValidateAccessTokenIdentity(Tokens.MintAccessToken(id, "guest@guest.local", "Guest", isGuest: true)));
    }

    [Fact]
    public void ValidateAccessToken_Expired_Null()
    {
        var expired = new JwtTokens(Settings(accessMinutes: -1)).MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false);

        Assert.Equal((null, false), Tokens.ValidateAccessToken(expired));
    }

    [Fact]
    public void ValidateAccessToken_OtherSecret_Null()
    {
        var forged = new JwtTokens(Settings(secret: "a-DIFFERENT-signing-key-long-enough-for-hmac-sha256-xyz"))
            .MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false);

        Assert.Equal((null, false), Tokens.ValidateAccessToken(forged));
    }

    [Fact]
    public void ValidateAccessToken_AdminTokenAndViceVersa_NeitherAccepted()
    {
        var id = Guid.NewGuid();
        var admin = Tokens.MintAdminAccessToken(id, "admin@example.test", AdminRole.Editor, 15);

        Assert.Equal((id, AdminRole.Editor), Tokens.ValidateAdminAccessToken(admin));
        Assert.Equal((null, false), Tokens.ValidateAccessToken(admin));
        Assert.Equal((null, null), Tokens.ValidateAdminAccessToken(Tokens.MintAccessToken(id, "reader@example.test", null, false)));
    }

    [Fact]
    public void MintAccessToken_ReaderAndAdmin_CarryIssuedAtAndTheirLifetime()
    {
        var before = DateTime.UtcNow.AddSeconds(-1);
        var reader = new JwtSecurityTokenHandler().ReadJwtToken(Tokens.MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false));
        var admin = new JwtSecurityTokenHandler().ReadJwtToken(Tokens.MintAdminAccessToken(Guid.NewGuid(), "admin@example.test", AdminRole.Admin, 15));

        foreach (var token in new[] { reader, admin })
            Assert.InRange(token.IssuedAt, before, DateTime.UtcNow.AddSeconds(1));
        Assert.InRange(reader.ValidTo - reader.IssuedAt, TimeSpan.FromMinutes(59), TimeSpan.FromMinutes(61));
        Assert.InRange(admin.ValidTo - admin.IssuedAt, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(16));
    }

    [Fact]
    public void ValidateAdminAccessToken_AdminAudienceWithoutIsAdmin_Null()
    {
        var token = TestTokens.Token(Guid.NewGuid(), audience: JwtSettings.AdminAudience);

        Assert.Equal((null, null), Tokens.ValidateAdminAccessToken(token));
    }

    [Fact]
    public void ValidateAdminAccessToken_IsAdminOnAReadersAudience_Null()
    {
        var id = Guid.NewGuid();
        var token = new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            TestTokens.Issuer, JwtSettings.UserAudience,
            [new Claim(ClaimTypes.NameIdentifier, id.ToString()), new Claim(ClaimTypes.Role, "Admin"), new Claim("is_admin", "true")],
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(System.Text.Encoding.UTF8.GetBytes(TestTokens.Secret)), SecurityAlgorithms.HmacSha256)));

        Assert.Equal((null, null), Tokens.ValidateAdminAccessToken(token));
    }

    [Fact]
    public void RefreshTokenDays_GuestOrAccount_ItsOwnWindow()
    {
        Assert.Equal((7, 30), (Tokens.RefreshTokenDays(isGuest: true), Tokens.RefreshTokenDays(isGuest: false)));
    }

    [Fact]
    public void NewOpaqueToken_Hash_IsTheStoredHashOfTheRawValue()
    {
        var (raw, hash) = JwtTokens.NewOpaqueToken();

        Assert.Equal(DeviceCodes.HashToken(raw), hash);
        Assert.NotEqual(raw, JwtTokens.NewOpaqueToken().Raw);
    }

    [Fact]
    public async Task VerifyAppleAsync_SignedByApplesKeyForThisApp_SubjectAndEmail()
    {
        var apple = await AppleTokens().VerifyAppleAsync(AppleToken(AppleKey));

        Assert.Equal(("apple-subject", "reader@privaterelay.appleid.com"), (apple!.Subject, apple.Email));
    }

    [Fact]
    public async Task VerifyAppleAsync_SignedByAnotherKeyWithApplesKid_Null()
    {
        Assert.Null(await AppleTokens().VerifyAppleAsync(AppleToken(new RsaSecurityKey(RSA.Create(2048)) { KeyId = AppleKey.KeyId })));
    }

    [Fact]
    public async Task VerifyAppleAsync_UnsignedOrAlgNone_Null()
    {
        var tokens = AppleTokens();
        var unsigned = new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            JwtTokens.AppleIssuer, "app.textstack", [new Claim("sub", "apple-subject")], expires: DateTime.UtcNow.AddMinutes(5)));

        var noneWithApplesKid = new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            new JwtHeader { ["kid"] = AppleKey.KeyId },
            new JwtPayload(JwtTokens.AppleIssuer, "app.textstack", [new Claim("sub", "apple-subject")], null, DateTime.UtcNow.AddMinutes(5))));

        Assert.Null(await tokens.VerifyAppleAsync(noneWithApplesKid));
        Assert.Null(await tokens.VerifyAppleAsync(unsigned));
        Assert.Null(await tokens.VerifyAppleAsync(unsigned + "forged-signature"));
        Assert.Null(await tokens.VerifyAppleAsync("not a jwt"));
        Assert.Equal(1, tokens.Fetches); // only for the token that names a kid
    }

    [Theory]
    [InlineData("https://evil.example", "app.textstack", 5)]
    [InlineData(JwtTokens.AppleIssuer, "another.app", 5)]
    [InlineData(JwtTokens.AppleIssuer, "app.textstack", -1)]
    public async Task VerifyAppleAsync_WrongIssuerAudienceOrExpired_Null(string issuer, string audience, int expiresInMinutes)
    {
        Assert.Null(await AppleTokens().VerifyAppleAsync(AppleToken(AppleKey, issuer, audience, expiresInMinutes)));
    }

    [Fact]
    public async Task VerifyAppleAsync_NoBundleIdConfigured_AnyAudienceAccepted()
    {
        Assert.NotNull(await AppleTokens(bundleId: null).VerifyAppleAsync(AppleToken(AppleKey, audience: "another.app")));
    }

    [Fact]
    public async Task VerifyAppleAsync_UnknownKid_OneRefreshThenNull()
    {
        var tokens = AppleTokens();

        Assert.Null(await tokens.VerifyAppleAsync(AppleToken(new RsaSecurityKey(RSA.Create(2048)) { KeyId = "rotated" })));

        Assert.Equal(1, tokens.Refreshes);
    }

    private static readonly RsaSecurityKey AppleKey = new(RSA.Create(2048)) { KeyId = "apple-kid" };

    private static FakeAppleKeys AppleTokens(string? bundleId = "app.textstack") =>
        new(bundleId is null ? null : new AppleSettings { BundleId = bundleId });

    /// <summary>Apple's key set, stood in for by <see cref="AppleKey"/>; counts fetches and refreshes.</summary>
    private sealed class FakeAppleKeys(AppleSettings? apple) : JwtTokens(Settings(), apple: apple)
    {
        public int Fetches { get; private set; }
        public int Refreshes { get; private set; }

        protected override Task<JsonWebKeySet?> GetAppleKeysAsync(bool refresh)
        {
            Fetches++;
            if (refresh) Refreshes++;
            var keys = new JsonWebKeySet();
            keys.Keys.Add(JsonWebKeyConverter.ConvertFromRSASecurityKey(new RsaSecurityKey(AppleKey.Rsa.ExportParameters(false)) { KeyId = AppleKey.KeyId }));
            return Task.FromResult<JsonWebKeySet?>(keys);
        }
    }

    [Fact]
    public async Task VerifyGoogleAsync_NoGoogleSettings_Null()
    {
        Assert.Null(await Tokens.VerifyGoogleAsync("anything"));
    }

    private static string AppleToken(
        RsaSecurityKey key, string issuer = JwtTokens.AppleIssuer, string audience = "app.textstack", int expiresInMinutes = 5) =>
        new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuer: issuer, audience: audience,
            claims: [new Claim("sub", "apple-subject"), new Claim("email", "reader@privaterelay.appleid.com")],
            notBefore: DateTime.UtcNow.AddMinutes(-10),
            expires: DateTime.UtcNow.AddMinutes(expiresInMinutes),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.RsaSha256)));
}
