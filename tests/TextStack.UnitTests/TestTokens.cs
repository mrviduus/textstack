using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Application.Auth;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests;

/// <summary>
/// Reader access tokens for tests that need a session: minted by <see cref="JwtTokens"/> itself unless a
/// test forges one (another issuer, secret, lifetime, audience, algorithm, no user or an odd guest claim).
/// </summary>
internal static class TestTokens
{
    public const string Secret = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh";
    public const string Issuer = "textstack.app";

    private static readonly JwtTokens Minter = new(new JwtSettings { SecretKey = Secret, Issuer = Issuer });

    public static string Token(
        Guid? userId,
        bool guestClaim = false,
        string? guestClaimValue = "true",
        string issuer = Issuer,
        string secret = Secret,
        int expiresInMinutes = 60,
        string? audience = JwtSettings.UserAudience,
        string algorithm = SecurityAlgorithms.HmacSha256)
    {
        var forged = guestClaimValue != "true" || issuer != Issuer || secret != Secret || expiresInMinutes != 60
            || audience != JwtSettings.UserAudience || algorithm != SecurityAlgorithms.HmacSha256;
        if (userId is { } user && !forged)
            return Minter.MintAccessToken(user, "reader@example.test", "Reader", guestClaim);

        var claims = new List<Claim>
        {
            new(ClaimTypes.Email, "reader@example.test"),
            new(ClaimTypes.Name, "Reader"),
        };
        if (userId is { } id) claims.Insert(0, new Claim(ClaimTypes.NameIdentifier, id.ToString()));
        if (guestClaim) claims.Add(new Claim(JwtTokens.GuestClaimType, guestClaimValue!));

        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: audience,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(expiresInMinutes),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)), algorithm));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
