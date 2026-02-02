using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Application.AdminSettings;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Application.AdminAuth;

public class AdminAuthService
{
    private readonly IAppDbContext _db;
    private readonly JwtSettings _jwtSettings;
    private readonly AdminSettingsService _settingsService;

    public AdminAuthService(IAppDbContext db, IOptions<JwtSettings> jwtSettings, AdminSettingsService settingsService)
    {
        _db = db;
        _jwtSettings = jwtSettings.Value;
        _settingsService = settingsService;
    }

    public async Task<(AdminUser user, string accessToken, string refreshToken)?> LoginAsync(
        string email,
        string password,
        CancellationToken ct)
    {
        var user = await _db.AdminUsers
            .FirstOrDefaultAsync(x => x.Email == email && x.IsActive, ct);

        if (user == null)
            return null;

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
            return null;

        var accessToken = await GenerateAccessTokenAsync(user, ct);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);

        return (user, accessToken, refreshToken);
    }

    public async Task<(AdminUser user, string accessToken, string refreshToken)?> RefreshTokenAsync(
        string refreshToken,
        CancellationToken ct)
    {
        var token = await _db.AdminRefreshTokens
            .Include(x => x.AdminUser)
            .FirstOrDefaultAsync(x => x.Token == refreshToken && x.ExpiresAt > DateTimeOffset.UtcNow, ct);

        if (token == null || !token.AdminUser.IsActive)
            return null;

        // Rotate refresh token
        _db.AdminRefreshTokens.Remove(token);
        var newRefreshToken = await CreateRefreshTokenAsync(token.AdminUserId, ct);
        var accessToken = await GenerateAccessTokenAsync(token.AdminUser, ct);

        return (token.AdminUser, accessToken, newRefreshToken);
    }

    public async Task<bool> LogoutAsync(string refreshToken, CancellationToken ct)
    {
        var token = await _db.AdminRefreshTokens
            .FirstOrDefaultAsync(x => x.Token == refreshToken, ct);

        if (token == null)
            return false;

        _db.AdminRefreshTokens.Remove(token);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<AdminUser?> GetAdminByIdAsync(Guid adminId, CancellationToken ct)
    {
        return await _db.AdminUsers.FirstOrDefaultAsync(x => x.Id == adminId && x.IsActive, ct);
    }

    public (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken)
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

            var adminIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            var roleClaim = principal.FindFirst(ClaimTypes.Role)?.Value;
            var isAdminClaim = principal.FindFirst("is_admin")?.Value;

            // Verify this is an admin token
            if (isAdminClaim != "true")
                return (null, null);

            if (adminIdClaim == null || !Guid.TryParse(adminIdClaim, out var adminId))
                return (null, null);

            AdminRole? role = null;
            if (roleClaim != null && Enum.TryParse<AdminRole>(roleClaim, out var parsedRole))
                role = parsedRole;

            return (adminId, role);
        }
        catch
        {
            return (null, null);
        }
    }

    public async Task<AdminUser> CreateAdminUserAsync(
        string email,
        string password,
        AdminRole role,
        CancellationToken ct)
    {
        var existingUser = await _db.AdminUsers.FirstOrDefaultAsync(x => x.Email == email, ct);
        if (existingUser != null)
            throw new InvalidOperationException($"Admin user with email {email} already exists");

        var user = new AdminUser
        {
            Id = Guid.NewGuid(),
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            Role = role,
            IsActive = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };

        _db.AdminUsers.Add(user);
        await _db.SaveChangesAsync(ct);
        return user;
    }

    public async Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default)
    {
        return await _settingsService.GetAccessTokenExpiryMinutesAsync(ct);
    }

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default)
    {
        return await _settingsService.GetRefreshTokenExpiryDaysAsync(ct);
    }

    private async Task<string> GenerateAccessTokenAsync(AdminUser user, CancellationToken ct)
    {
        var expiryMinutes = await _settingsService.GetAccessTokenExpiryMinutesAsync(ct);
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwtSettings.SecretKey));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Role, user.Role.ToString()),
            new Claim("is_admin", "true")
        };

        var token = new JwtSecurityToken(
            issuer: _jwtSettings.Issuer,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(expiryMinutes),
            signingCredentials: credentials
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private async Task<string> CreateRefreshTokenAsync(Guid adminUserId, CancellationToken ct)
    {
        var expiryDays = await _settingsService.GetRefreshTokenExpiryDaysAsync(ct);
        var token = new AdminRefreshToken
        {
            Id = Guid.NewGuid(),
            AdminUserId = adminUserId,
            Token = GenerateSecureToken(),
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(expiryDays),
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.AdminRefreshTokens.Add(token);
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
