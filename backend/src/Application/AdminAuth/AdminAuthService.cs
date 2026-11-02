using Application.AdminSettings;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Application.AdminAuth;

public class AdminAuthService : IAdminAuthService
{
    private readonly IAppDbContext _db;
    private readonly JwtTokens _tokens;
    private readonly AdminSettingsService _settingsService;

    public AdminAuthService(IAppDbContext db, IOptions<JwtSettings> jwtSettings, AdminSettingsService settingsService)
    {
        _db = db;
        _tokens = new JwtTokens(jwtSettings.Value);
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

        if (!Application.Auth.PasswordHashing.Matches(password, user.PasswordHash))
            return null;

        var accessToken = await GenerateAccessTokenAsync(user, ct);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);

        return (user, accessToken, refreshToken);
    }

    public async Task<(AdminUser user, string accessToken, string refreshToken)?> RefreshTokenAsync(
        string refreshToken,
        CancellationToken ct)
    {
        var hash = DeviceCodes.HashToken(refreshToken);
        var token = await _db.AdminRefreshTokens
            .Include(x => x.AdminUser)
            .FirstOrDefaultAsync(x => x.TokenHash == hash && x.ExpiresAt > DateTimeOffset.UtcNow, ct);

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
        var hash = DeviceCodes.HashToken(refreshToken);
        var token = await _db.AdminRefreshTokens
            .FirstOrDefaultAsync(x => x.TokenHash == hash, ct);

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

    public (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken) => _tokens.ValidateAdminAccessToken(accessToken);

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

    async Task<AdminAuthResult?> IAdminAuthService.LoginAsync(string email, string password, CancellationToken ct) =>
        Result(await LoginAsync(email, password, ct));

    async Task<AdminAuthResult?> IAdminAuthService.RefreshTokenAsync(string refreshToken, CancellationToken ct) =>
        Result(await RefreshTokenAsync(refreshToken, ct));

    async Task<AdminUserDto?> IAdminAuthService.GetAdminByIdAsync(Guid adminId, CancellationToken ct) =>
        await GetAdminByIdAsync(adminId, ct) is { } admin ? ToDto(admin) : null;

    private static AdminAuthResult? Result((AdminUser user, string accessToken, string refreshToken)? session) =>
        session is { } s ? new AdminAuthResult(ToDto(s.user), s.accessToken, s.refreshToken) : null;

    private static AdminUserDto ToDto(AdminUser user) => new(user.Id, user.Email, user.Role, user.CreatedAt);

    public async Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default)
    {
        return await _settingsService.GetAccessTokenExpiryMinutesAsync(ct);
    }

    public async Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default)
    {
        return await _settingsService.GetRefreshTokenExpiryDaysAsync(ct);
    }

    private async Task<string> GenerateAccessTokenAsync(AdminUser user, CancellationToken ct) =>
        _tokens.MintAdminAccessToken(user.Id, user.Email, user.Role, await _settingsService.GetAccessTokenExpiryMinutesAsync(ct));

    private async Task<string> CreateRefreshTokenAsync(Guid adminUserId, CancellationToken ct)
    {
        var expiryDays = await _settingsService.GetRefreshTokenExpiryDaysAsync(ct);
        // Only the hash is stored; the raw token leaves this method once, to the client.
        var raw = DeviceCodes.GenerateSecureToken();
        var token = new AdminRefreshToken
        {
            Id = Guid.NewGuid(),
            AdminUserId = adminUserId,
            TokenHash = DeviceCodes.HashToken(raw),
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(expiryDays),
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.AdminRefreshTokens.Add(token);
        await _db.SaveChangesAsync(ct);
        return raw;
    }
}
