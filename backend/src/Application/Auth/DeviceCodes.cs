using System.Security.Cryptography;
using System.Text;

namespace Application.Auth;

/// <summary>
/// Pure helpers for the device-grant flow (AI-050a): user_code generation +
/// normalization + token hashing. Extracted from <see cref="AuthService"/> so the
/// security-relevant logic is unit-testable without a DB or live server.
/// </summary>
public static class DeviceCodes
{
    /// <summary>RFC 8628 expires_in of a device login: ten minutes.</summary>
    public const int ExpiresInSeconds = 600;

    /// <summary>RFC 8628 polling interval.</summary>
    public const int IntervalSeconds = 5;

    /// <summary>How many random user codes a new device login tries before giving up (a clash among live ones).</summary>
    public const int UserCodeAttempts = 8;

    // Crockford base32 minus ambiguous chars (no I, O, 0, 1).
    public const string UserCodeAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

    /// <summary>8 chars from the unambiguous alphabet, grouped "XXXX-XXXX".</summary>
    public static string GenerateUserCode()
    {
        Span<char> chars = stackalloc char[8];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = UserCodeAlphabet[RandomNumberGenerator.GetInt32(UserCodeAlphabet.Length)];
        return $"{new string(chars[..4])}-{new string(chars[4..])}";
    }

    /// <summary>Uppercase + strip whitespace/dashes, then re-group as "XXXX-XXXX".</summary>
    public static string NormalizeUserCode(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
            return "";
        var stripped = new string(input.Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (stripped.Length != 8)
            return stripped; // != 8 → let the DB lookup miss (returns "" only for empty input)
        return $"{stripped[..4]}-{stripped[4..]}";
    }

    /// <summary>SHA256-hex of a secret (device_code). Matches PasswordResetToken hashing.</summary>
    public static string HashToken(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexStringLower(bytes);
    }

    /// <summary>64-byte cryptographically-random base64 secret (the device_code).</summary>
    public static string GenerateSecureToken()
    {
        var bytes = new byte[64];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes);
    }
}
