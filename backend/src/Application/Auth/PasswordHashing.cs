using Microsoft.Extensions.Logging;
namespace Application.Auth;

/// <summary>The password rules legacy and V2 sign-in share: what is accepted, how it is hashed and checked.</summary>
public static class PasswordHashing
{
    public const int MinLength = 8;
    public const int MaxLength = 128;

    /// <summary>How long a password reset code can be redeemed.</summary>
    public static readonly TimeSpan ResetCodeLifetime = TimeSpan.FromHours(1);

    public static bool IsAcceptable(string password) => password.Length is >= MinLength and <= MaxLength;

    public static string Hash(string password) => BCrypt.Net.BCrypt.HashPassword(password);

    /// <summary>
    /// A hash BCrypt cannot parse (a bad hand edit, a truncated value) is a failed login, not a 500.
    /// BCrypt.Net throws several exception types for corrupt input; none of them means "match".
    /// </summary>
    public static bool Matches(string password, string? hash, ILogger? logger = null)
    {
        if (string.IsNullOrEmpty(hash)) return false;
        try { return BCrypt.Net.BCrypt.Verify(password, hash); }
        catch (Exception ex)
        {
            // Every login for this account fails until the hash is fixed: worth seeing.
            logger?.LogWarning(ex, "A stored password hash could not be read");
            return false;
        }
    }
}
