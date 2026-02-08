using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Application.Common.Interfaces;
using Domain.Entities;
using Google.Apis.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

public class AuthService
{
    private readonly IAppDbContext _db;
    private readonly JwtSettings _jwtSettings;
    private readonly GoogleSettings _googleSettings;

    public AuthService(
        IAppDbContext db,
        IOptions<JwtSettings> jwtSettings,
        IOptions<GoogleSettings> googleSettings)
    {
        _db = db;
        _jwtSettings = jwtSettings.Value;
        _googleSettings = googleSettings.Value;
    }

    public async Task<(User user, string accessToken, string refreshToken)> TestLoginAsync(
        string email,
        CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(x => x.Email == email, ct);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                Email = email,
                Name = email.Split('@')[0],
                GoogleSubject = $"test_{Guid.NewGuid()}",
                CreatedAt = DateTimeOffset.UtcNow
            };
            _db.Users.Add(user);
            await _db.SaveChangesAsync(ct);
        }

        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);
        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> LoginWithGoogleAsync(
        string googleIdToken,
        CancellationToken ct)
    {
        GoogleJsonWebSignature.Payload payload;
        try
        {
            payload = await GoogleJsonWebSignature.ValidateAsync(googleIdToken, new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = [_googleSettings.ClientId]
            });
        }
        catch (InvalidJwtException)
        {
            return null;
        }

        var user = await GetOrCreateUserAsync(payload, ct);
        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);

        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> RefreshTokenAsync(
        string refreshToken,
        CancellationToken ct)
    {
        var token = await _db.UserRefreshTokens
            .Include(x => x.User)
            .FirstOrDefaultAsync(x => x.Token == refreshToken && x.ExpiresAt > DateTimeOffset.UtcNow, ct);

        if (token == null)
            return null;

        // Rotate refresh token
        _db.UserRefreshTokens.Remove(token);
        var newRefreshToken = await CreateRefreshTokenAsync(token.UserId, ct);
        var accessToken = GenerateAccessToken(token.User);

        return (token.User, accessToken, newRefreshToken);
    }

    public async Task<bool> LogoutAsync(string refreshToken, CancellationToken ct)
    {
        var token = await _db.UserRefreshTokens
            .FirstOrDefaultAsync(x => x.Token == refreshToken, ct);

        if (token == null)
            return false;

        _db.UserRefreshTokens.Remove(token);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<User?> GetUserByIdAsync(Guid userId, CancellationToken ct)
    {
        return await _db.Users.FirstOrDefaultAsync(x => x.Id == userId, ct);
    }

    public Guid? ValidateAccessToken(string accessToken)
    {
        var tokenHandler = new JwtSecurityTokenHandler();
        var key = Encoding.UTF8.GetBytes(_jwtSettings.SecretKey);

        try
        {
            var principal = tokenHandler.ValidateToken(accessToken, new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(key),
                ValidateIssuer = true,
                ValidIssuer = _jwtSettings.Issuer,
                ValidateAudience = false,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            }, out _);

            var userIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            return userIdClaim != null ? Guid.Parse(userIdClaim) : null;
        }
        catch
        {
            return null;
        }
    }

    private async Task<User> GetOrCreateUserAsync(GoogleJsonWebSignature.Payload payload, CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(x => x.GoogleSubject == payload.Subject, ct);

        if (user != null)
        {
            // Update name/email/picture if changed
            if (user.Email != payload.Email || user.Name != payload.Name || user.Picture != payload.Picture)
            {
                user.Email = payload.Email;
                user.Name = payload.Name;
                user.Picture = payload.Picture;
                await _db.SaveChangesAsync(ct);
            }
            return user;
        }

        user = new User
        {
            Id = Guid.NewGuid(),
            Email = payload.Email,
            Name = payload.Name,
            Picture = payload.Picture,
            GoogleSubject = payload.Subject,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(ct);
        return user;
    }

    private string GenerateAccessToken(User user)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwtSettings.SecretKey));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Name, user.Name ?? user.Email)
        };

        var token = new JwtSecurityToken(
            issuer: _jwtSettings.Issuer,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(_jwtSettings.AccessTokenExpiryMinutes),
            signingCredentials: credentials
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private async Task<string> CreateRefreshTokenAsync(Guid userId, CancellationToken ct)
    {
        var token = new UserRefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Token = GenerateSecureToken(),
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(_jwtSettings.RefreshTokenExpiryDays),
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.UserRefreshTokens.Add(token);
        await _db.SaveChangesAsync(ct);
        return token.Token;
    }

    private static string GenerateSecureToken()
    {
        var bytes = new byte[64];
        using var rng = RandomNumberGenerator.Create();
        rng.GetBytes(bytes);
        return Convert.ToBase64String(bytes);
    }
}
