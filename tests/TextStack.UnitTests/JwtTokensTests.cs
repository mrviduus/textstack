using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Application.Auth;
using Domain.Enums;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests;

/// <summary>The token code legacy <c>AuthService</c> and <see cref="Application.Identity.AuthService"/> share.</summary>
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
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);

        var identity = Tokens.ValidateAccessToken(Tokens.MintAccessToken(id, "reader@example.test", null, isGuest))!;

        Assert.Equal((id, isGuest), (identity.UserId, identity.IsGuest));
        Assert.InRange(identity.IssuedAt, before, DateTimeOffset.UtcNow);
    }

    [Fact]
    public void MintAccessToken_IssuedAtGiven_StampsItToTheTick()
    {
        // Taken before the session write: a reset committing after it must post-date the token.
        var issuedAt = DateTimeOffset.UtcNow.AddMilliseconds(-1234.5678);

        var identity = Tokens.ValidateAccessToken(Tokens.MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false, issuedAt))!;
        var admin = Tokens.ValidateAdminAccessTokenIdentity(Tokens.MintAdminAccessToken(Guid.NewGuid(), "admin@example.test", AdminRole.Admin, 15, issuedAt))!;

        Assert.Equal((issuedAt, issuedAt), (identity.IssuedAt, admin.IssuedAt));
    }

    [Fact]
    public void ValidateAccessToken_Expired_Null()
    {
        var expired = new JwtTokens(Settings(accessMinutes: -1)).MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false);

        Assert.Null(Tokens.ValidateAccessToken(expired));
    }

    [Fact]
    public void ValidateAccessToken_OtherSecret_Null()
    {
        var forged = new JwtTokens(Settings(secret: "a-DIFFERENT-signing-key-long-enough-for-hmac-sha256-xyz"))
            .MintAccessToken(Guid.NewGuid(), "reader@example.test", null, false);

        Assert.Null(Tokens.ValidateAccessToken(forged));
    }

    [Fact]
    public void ValidateAccessToken_AdminTokenAndViceVersa_NeitherAccepted()
    {
        var id = Guid.NewGuid();
        var admin = Tokens.MintAdminAccessToken(id, "admin@example.test", AdminRole.Editor, 15);

        Assert.Equal((id, AdminRole.Editor), Tokens.ValidateAdminAccessToken(admin));
        Assert.Null(Tokens.ValidateAccessToken(admin));
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
    public async Task VerifyGoogleAsync_NoGoogleSettings_Null()
    {
        Assert.Null(await new ProviderTokens().VerifyGoogleAsync("anything"));
    }
}
