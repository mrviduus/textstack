using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Application.Auth;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests;

/// <summary>Access tokens shaped as <c>AuthService.GenerateAccessToken</c> mints them, for tests that need a session.</summary>
internal static class TestTokens
{
    public const string Secret = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh";
    public const string Issuer = "textstack.app";

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
