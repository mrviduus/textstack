using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Domain.Identity;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;

namespace Application.Identity;

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

    public const string IssuedAtTicksClaim = "ts_iat_ticks";

    private static readonly JwtSecurityTokenHandler Handler = new();

    private readonly JwtSettings _jwt;
    private readonly TimeProvider _clock;
    private readonly SigningCredentials _signing;
    private readonly TokenValidationParameters _readerValidation;
    private readonly TokenValidationParameters _adminValidation;

    private readonly ILogger? _logger;

    /// <param name="clock">What <c>iat</c> and expiry are minted from; the system clock unless a test sets it.</param>
    /// <param name="logger">Where a validation failure that is not a bad token goes (a key misconfiguration).</param>
    public JwtTokens(JwtSettings jwt, TimeProvider? clock = null, ILogger<JwtTokens>? logger = null)
    {
        _jwt = jwt;
        _logger = logger;
        _clock = clock ?? TimeProvider.System;
        _signing = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SecretKey)), SecurityAlgorithms.HmacSha256);
        _readerValidation = jwt.ValidationParameters(JwtSettings.UserAudience);
        _adminValidation = jwt.ValidationParameters(JwtSettings.AdminAudience);
    }

    /// <summary>
    /// A reader's (or guest's) access token. <paramref name="issuedAt"/>: its <c>iat</c>, taken before the
    /// session write it rides on, so a reset committing in between still post-dates it; now when null.
    /// </summary>
    public string MintAccessToken(Guid userId, string email, string? name, bool isGuest, DateTimeOffset? issuedAt = null)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, userId.ToString()),
            new(ClaimTypes.Email, email),
            new(ClaimTypes.Name, name ?? email)
        };
        if (isGuest)
            claims.Add(new Claim(GuestClaimType, "true"));

        return Write(claims, JwtSettings.UserAudience, _jwt.AccessTokenExpiryMinutes, issuedAt);
    }

    /// <summary>The user a reader's access token names, whether it is a guest's, and its <c>iat</c>; null when it does not validate.</summary>
    public AccessTokenIdentity? ValidateAccessToken(string accessToken)
    {
        try
        {
            var principal = Handler.ValidateToken(accessToken, _readerValidation, out var validated);

            var userIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (userIdClaim == null) return null;

            var isGuest = principal.FindFirst(GuestClaimType)?.Value == "true";
            return new AccessTokenIdentity(Guid.Parse(userIdClaim), isGuest, IssuedAt((JwtSecurityToken)validated));
        }
        catch (Exception ex)
        {
            if (IsUnexpected(ex))
                _logger?.LogWarning(ex, "Token validation failed for a reason other than an expired or misdirected token");
            return null;
        }
    }

    /// <summary>An admin-panel access token, living <paramref name="expiryMinutes"/> (the admin panel's setting); <paramref name="issuedAt"/> as for <see cref="MintAccessToken"/>.</summary>
    public string MintAdminAccessToken(Guid adminId, string email, AdminRole role, int expiryMinutes, DateTimeOffset? issuedAt = null) =>
        Write(
        [
            new Claim(ClaimTypes.NameIdentifier, adminId.ToString()),
            new Claim(ClaimTypes.Email, email),
            new Claim(ClaimTypes.Role, role.ToString()),
            new Claim(AdminClaimType, "true")
        ], JwtSettings.AdminAudience, expiryMinutes, issuedAt);

    /// <summary>The admin an admin-panel token names and its role; <c>(null, null)</c> when it does not validate.</summary>
    public (Guid? AdminId, AdminRole? Role) ValidateAdminAccessToken(string accessToken)
    {
        var identity = ValidateAdminAccessTokenIdentity(accessToken);
        return (identity?.AdminId, identity?.Role);
    }

    public AdminAccessTokenIdentity? ValidateAdminAccessTokenIdentity(string accessToken)
    {
        try
        {
            var principal = Handler.ValidateToken(accessToken, _adminValidation, out var validated);

            if (principal.FindFirst(AdminClaimType)?.Value != "true")
                return null;

            var adminIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (adminIdClaim == null || !Guid.TryParse(adminIdClaim, out var adminId))
                return null;

            var roleClaim = principal.FindFirst(ClaimTypes.Role)?.Value;
            AdminRole? role = roleClaim != null && Enum.TryParse<AdminRole>(roleClaim, out var parsed) ? parsed : null;
            return new AdminAccessTokenIdentity(adminId, role, IssuedAt((JwtSecurityToken)validated));
        }
        catch (Exception ex)
        {
            if (IsUnexpected(ex))
                _logger?.LogWarning(ex, "Token validation failed for a reason other than an expired or misdirected token");
            return null;
        }
    }

    // An expired, garbled or other-audience token is an everyday "no". A bad signature is logged: it is
    // either forged or signed with another key, and every token failing that way is a key mismatch.
    private static bool IsUnexpected(Exception ex) => ex is not (SecurityTokenExpiredException
        or SecurityTokenNotYetValidException or SecurityTokenMalformedException or SecurityTokenInvalidAudienceException
        or SecurityTokenInvalidIssuerException or SecurityTokenNoExpirationException)
        && ex.GetType() != typeof(ArgumentException);

    // JWT iat is whole seconds. Keep full precision for reset checks, including a new sign-in
    // during the same second as a reset. Old signed tokens retain the conservative iat fallback.
    private static DateTimeOffset IssuedAt(JwtSecurityToken token) =>
        token.Claims.SingleOrDefault(c => c.Type == IssuedAtTicksClaim) is { } claim
            ? new DateTimeOffset(long.Parse(claim.Value, CultureInfo.InvariantCulture), TimeSpan.Zero)
            : new DateTimeOffset(token.IssuedAt, TimeSpan.Zero);

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
    private string Write(IEnumerable<Claim> claims, string audience, int expiryMinutes, DateTimeOffset? issuedAt)
    {
        var now = (issuedAt ?? _clock.GetUtcNow()).UtcDateTime;
        var token = new JwtSecurityToken(
            issuer: _jwt.Issuer,
            audience: audience,
            claims: claims.Append(new Claim(JwtRegisteredClaimNames.Iat,
                EpochTime.GetIntDate(now).ToString(CultureInfo.InvariantCulture), ClaimValueTypes.Integer64))
                .Append(new Claim(IssuedAtTicksClaim, now.Ticks.ToString(CultureInfo.InvariantCulture), ClaimValueTypes.Integer64)),
            expires: now.AddMinutes(expiryMinutes),
            signingCredentials: _signing);
        return Handler.WriteToken(token);
    }
}

/// <summary>
/// What a validated reader access token says: whose it is, whether a guest's, and when it was issued
/// (UTC, full tick precision from <c>ts_iat_ticks</c>; whole-second <c>iat</c> only for tokens minted before it),
/// which a credential minted from it is checked against (#1092).
/// </summary>
public sealed record AccessTokenIdentity(Guid UserId, bool IsGuest, DateTimeOffset IssuedAt);

public sealed record AdminAccessTokenIdentity(Guid AdminId, AdminRole? Role, DateTimeOffset IssuedAt);
