using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Domain.Enums;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

/// <summary>
/// Access tokens and opaque secrets, shared by every sign-in (legacy and V2, readers and admins). Pure:
/// no database, no provider.
/// </summary>
public sealed class JwtTokens
{
    /// <summary>Marks a guest's access token: one definition for minting and reading, so they cannot drift.</summary>
    public const string GuestClaimType = "is_guest";

    /// <summary>Marks an admin-panel access token.</summary>
    public const string AdminClaimType = "is_admin";

    private static readonly JwtSecurityTokenHandler Handler = new();

    private readonly JwtSettings _jwt;
    private readonly SigningCredentials _signing;
    private readonly TokenValidationParameters _readerValidation;
    private readonly TokenValidationParameters _adminValidation;

    public JwtTokens(JwtSettings jwt)
    {
        _jwt = jwt;
        _signing = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SecretKey)), SecurityAlgorithms.HmacSha256);
        _readerValidation = jwt.ValidationParameters(JwtSettings.UserAudience);
        _adminValidation = jwt.ValidationParameters(JwtSettings.AdminAudience);
    }

    /// <summary>A reader's (or guest's) access token.</summary>
    public string MintAccessToken(Guid userId, string email, string? name, bool isGuest)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, userId.ToString()),
            new(ClaimTypes.Email, email),
            new(ClaimTypes.Name, name ?? email)
        };
        if (isGuest)
            claims.Add(new Claim(GuestClaimType, "true"));

        return Write(claims, JwtSettings.UserAudience, _jwt.AccessTokenExpiryMinutes);
    }

    /// <summary>The user a reader's access token names and whether it is a guest's; <c>(null, false)</c> when it does not validate.</summary>
    public (Guid? UserId, bool IsGuest) ValidateAccessToken(string accessToken)
    {
        try
        {
            var principal = Handler.ValidateToken(accessToken, _readerValidation, out _);

            var userIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (userIdClaim == null) return (null, false);

            var isGuest = principal.FindFirst(GuestClaimType)?.Value == "true";
            return (Guid.Parse(userIdClaim), isGuest);
        }
        catch
        {
            return (null, false);
        }
    }

    /// <summary>An admin-panel access token, living <paramref name="expiryMinutes"/> (the admin panel's setting).</summary>
    public string MintAdminAccessToken(Guid adminId, string email, AdminRole role, int expiryMinutes) =>
        Write(
        [
            new Claim(ClaimTypes.NameIdentifier, adminId.ToString()),
            new Claim(ClaimTypes.Email, email),
            new Claim(ClaimTypes.Role, role.ToString()),
            new Claim(AdminClaimType, "true")
        ], JwtSettings.AdminAudience, expiryMinutes);

    /// <summary>The admin an admin-panel token names and its role; <c>(null, null)</c> when it does not validate.</summary>
    public (Guid? AdminId, AdminRole? Role) ValidateAdminAccessToken(string accessToken)
    {
        try
        {
            var principal = Handler.ValidateToken(accessToken, _adminValidation, out _);

            if (principal.FindFirst(AdminClaimType)?.Value != "true")
                return (null, null);

            var adminIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (adminIdClaim == null || !Guid.TryParse(adminIdClaim, out var adminId))
                return (null, null);

            var roleClaim = principal.FindFirst(ClaimTypes.Role)?.Value;
            AdminRole? role = roleClaim != null && Enum.TryParse<AdminRole>(roleClaim, out var parsed) ? parsed : null;
            return (adminId, role);
        }
        catch
        {
            return (null, null);
        }
    }

    /// <summary>A new opaque secret (a refresh token, a reset code): the raw value goes to the client once, only its hash is stored.</summary>
    public static (string Raw, string Hash) NewOpaqueToken()
    {
        var raw = DeviceCodes.GenerateSecureToken();
        return (raw, DeviceCodes.HashToken(raw));
    }

    /// <summary>How many days a reader's refresh token lives; guests have their own window.</summary>
    public int RefreshTokenDays(bool isGuest) =>
        isGuest ? _jwt.GuestRefreshTokenExpiryDays : _jwt.RefreshTokenExpiryDays;

    // iat: what a credentials-reset stamp is compared with.
    private string Write(IEnumerable<Claim> claims, string audience, int expiryMinutes)
    {
        var now = DateTime.UtcNow;
        var token = new JwtSecurityToken(
            issuer: _jwt.Issuer,
            audience: audience,
            claims: claims.Append(new Claim(JwtRegisteredClaimNames.Iat,
                EpochTime.GetIntDate(now).ToString(CultureInfo.InvariantCulture), ClaimValueTypes.Integer64)),
            expires: now.AddMinutes(expiryMinutes),
            signingCredentials: _signing);
        return Handler.WriteToken(token);
    }
}
