using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Domain.Enums;
using Google.Apis.Auth;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

/// <summary>A sign-in a provider vouched for: Google's verified id token, or Apple's identity token.</summary>
public sealed record ProviderIdentity(string Subject, string? Email, string? Name, string? Picture);

/// <summary>
/// The token code every sign-in shares, legacy and V2 alike (<see cref="IAuthService"/>,
/// <see cref="AdminAuth.IAdminAuthService"/>): access JWTs minted and validated, refresh tokens minted,
/// Google and Apple identity tokens read. No database. The provider checks are virtual so a test can
/// stand in for Google and Apple.
/// </summary>
public class JwtTokens(JwtSettings jwt, GoogleSettings? google = null, AppleSettings? apple = null)
{
    /// <summary>
    /// Marks an access token as a guest's. Minted in <see cref="MintAccessToken"/>, read by
    /// <see cref="ValidateAccessToken"/>: one definition so the two cannot drift, which is the failure
    /// that left the guest-activity middleware inert.
    /// </summary>
    public const string GuestClaimType = "is_guest";

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

        return Write(claims, JwtSettings.UserAudience, jwt.AccessTokenExpiryMinutes);
    }

    /// <summary>
    /// The user a reader's access token belongs to, and whether it is a guest's. <c>(null, false)</c>
    /// for a token that does not validate, so a caller cannot mistake an expired token for an account.
    /// </summary>
    public (Guid? UserId, bool IsGuest) ValidateAccessToken(string accessToken)
    {
        try
        {
            var principal = new JwtSecurityTokenHandler().ValidateToken(
                accessToken, jwt.ValidationParameters(JwtSettings.UserAudience), out _);

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

    /// <summary>An admin-panel access token; its lifetime is the admin panel's setting.</summary>
    public string MintAdminAccessToken(Guid adminId, string email, AdminRole role, int expiryMinutes) =>
        Write(
        [
            new Claim(ClaimTypes.NameIdentifier, adminId.ToString()),
            new Claim(ClaimTypes.Email, email),
            new Claim(ClaimTypes.Role, role.ToString()),
            new Claim("is_admin", "true")
        ], JwtSettings.AdminAudience, expiryMinutes);

    /// <summary>The admin an admin-panel token belongs to and its role; <c>(null, null)</c> when it does not validate.</summary>
    public (Guid? AdminId, AdminRole? Role) ValidateAdminAccessToken(string accessToken)
    {
        try
        {
            var principal = new JwtSecurityTokenHandler().ValidateToken(
                accessToken, jwt.ValidationParameters(JwtSettings.AdminAudience), out _);

            if (principal.FindFirst("is_admin")?.Value != "true")
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

    /// <summary>How long a refresh token lives: guests get their own (shorter or equal) window.</summary>
    public int RefreshTokenDays(bool isGuest) =>
        isGuest ? jwt.GuestRefreshTokenExpiryDays : jwt.RefreshTokenExpiryDays;

    /// <summary>The Google account a verified id token names, for this app's client ids; null when it does not verify.</summary>
    public virtual async Task<ProviderIdentity?> VerifyGoogleAsync(string idToken)
    {
        if (google is null) return null;
        try
        {
            var audiences = new List<string> { google.ClientId };
            if (!string.IsNullOrWhiteSpace(google.LegacyClientIds))
            {
                audiences.AddRange(google.LegacyClientIds.Split(
                    ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            }
            var payload = await GoogleJsonWebSignature.ValidateAsync(idToken, new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = audiences
            });
            return new ProviderIdentity(payload.Subject, payload.Email, payload.Name, payload.Picture);
        }
        catch (InvalidJwtException)
        {
            return null;
        }
    }

    /// <summary>
    /// The Apple account an identity token names; null when its audience, issuer or expiry is wrong.
    /// ponytail: signature not validated — legacy behaviour, owner-deferred 2026-11-02.
    /// </summary>
    public virtual ProviderIdentity? VerifyApple(string identityToken)
    {
        try
        {
            var token = new JwtSecurityTokenHandler().ReadJwtToken(identityToken);

            var audience = apple?.BundleId;
            if (audience != null && token.Audiences.All(a => a != audience))
                return null;

            if (token.Issuer != "https://appleid.apple.com")
                return null;

            if (token.ValidTo < DateTime.UtcNow)
                return null;

            var email = token.Claims.FirstOrDefault(c => c.Type == "email")?.Value;
            return token.Subject is null ? null : new ProviderIdentity(token.Subject, email, null, null);
        }
        catch
        {
            return null;
        }
    }

    // iat: what a credentials-reset stamp is compared with (#1092).
    private string Write(IEnumerable<Claim> claims, string audience, int expiryMinutes)
    {
        var now = DateTime.UtcNow;
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SecretKey));
        var token = new JwtSecurityToken(
            issuer: jwt.Issuer,
            audience: audience,
            claims: claims.Append(new Claim(JwtRegisteredClaimNames.Iat,
                EpochTime.GetIntDate(now).ToString(CultureInfo.InvariantCulture), ClaimValueTypes.Integer64)),
            expires: now.AddMinutes(expiryMinutes),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
