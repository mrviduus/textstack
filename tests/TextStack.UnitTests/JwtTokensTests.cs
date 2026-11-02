using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Application.Auth;
using Domain.Enums;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

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

    [Theory]
    [InlineData(ProviderTokens.AppleIssuer, "app.textstack", 5, true)]
    [InlineData("https://evil.example", "app.textstack", 5, false)]
    [InlineData(ProviderTokens.AppleIssuer, "another.app", 5, false)]
    [InlineData(ProviderTokens.AppleIssuer, "app.textstack", -1, false)]
    public void VerifyApple_IssuerAudienceExpiry_IdentityOnlyForApplesUnexpiredTokenForThisApp(string issuer, string audience, int expiresInMinutes, bool accepted)
    {
        var apple = new ProviderTokens(apple: new AppleSettings { BundleId = "app.textstack" })
            .VerifyApple(AppleToken(issuer, audience, expiresInMinutes));

        // The signature is not checked (owner-deferred), so the email proves nothing: nothing links by it.
        Assert.Equal(accepted ? ("apple-subject", "reader@privaterelay.appleid.com") : default, (apple?.Subject, apple?.Email));
    }

    [Fact]
    public void VerifyApple_NotAJwt_Null()
    {
        Assert.Null(new ProviderTokens().VerifyApple("not a jwt"));
    }

    [Fact]
    public async Task VerifyGoogleAsync_NoGoogleSettings_Null()
    {
        Assert.Null(await new ProviderTokens().VerifyGoogleAsync("anything"));
    }

    private static string AppleToken(string issuer, string audience, int expiresInMinutes = 5) => new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
        issuer: issuer, audience: audience,
        claims: [new Claim("sub", "apple-subject"), new Claim("email", "reader@privaterelay.appleid.com")],
        notBefore: DateTime.UtcNow.AddMinutes(-10),
        expires: DateTime.UtcNow.AddMinutes(expiresInMinutes)));
}
