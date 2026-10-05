using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

public class JwtSettings
{
    public const string SectionName = "Jwt";

    /// <summary>
    /// <c>aud</c> of a reader's access token (login, refresh, guest, device flow). User and admin
    /// tokens share the signing key and issuer, so the audience is what keeps one from being
    /// accepted as the other.
    /// </summary>
    public const string UserAudience = "textstack-user";

    /// <summary><c>aud</c> of an admin-panel access token. See <see cref="UserAudience"/>.</summary>
    public const string AdminAudience = "textstack-admin";

    /// <summary>Below this many UTF-8 bytes the HMAC-SHA256 key is weaker than the hash it feeds.</summary>
    public const int MinSecretKeyBytes = 32;

    public static bool IsWeakSecret(string? secret) =>
        !string.IsNullOrEmpty(secret) && Encoding.UTF8.GetByteCount(secret) < MinSecretKeyBytes;

    /// <summary>
    /// The one validation profile for both token kinds: this key, this issuer, the given audience,
    /// HS256 only, no clock skew.
    /// </summary>
    public TokenValidationParameters ValidationParameters(string audience) => new()
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(SecretKey)),
        ValidateIssuer = true,
        ValidIssuer = Issuer,
        ValidateAudience = true,
        ValidAudience = audience,
        ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
        ValidateLifetime = true,
        ClockSkew = TimeSpan.Zero
    };

    public required string SecretKey { get; set; }
    public string Issuer { get; set; } = "textstack.app";
    public int AccessTokenExpiryMinutes { get; set; } = 60;
    public int RefreshTokenExpiryDays { get; set; } = 30;
    // Guest cookie outlives the cleanup TTL (30d) so an engaged user who comes back after a few
    // weeks still has a valid session and the guest-row promotion path stays in-place (no merge).
    public int GuestRefreshTokenExpiryDays { get; set; } = 30;
}
