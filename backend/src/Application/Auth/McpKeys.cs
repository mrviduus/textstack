using System.Security.Cryptography;

namespace Application.Auth;

/// <summary>
/// Pure helpers for the MCP connect key — generation, shape, and the recogniser the request pipeline
/// uses. No DB, no HTTP, so the security-relevant parts are unit-testable on their own, the same
/// reason <see cref="DeviceCodes"/> exists.
/// <para>
/// Hashing is deliberately NOT duplicated here: <see cref="DeviceCodes.HashToken"/> already is
/// SHA-256-hex and is what <c>PasswordResetToken</c> and <c>DeviceAuthorization</c> store. Two hash
/// helpers is how two of them end up disagreeing.
/// </para>
/// </summary>
public static class McpKeys
{
    /// <summary>
    /// Marks a bearer as a connect key rather than a JWT. The pipeline tests for this prefix before
    /// touching the database, so a request carrying an ordinary access token costs nothing extra.
    /// A JWT can never collide with it: JWTs are three base64url segments joined by dots and start
    /// with <c>eyJ</c>.
    /// </summary>
    public const string Prefix = "tsk_";

    /// <summary>
    /// How much of the raw key is stored in clear for display. Enough to tell two keys apart in a
    /// list and to match a row against the string sitting in a config file; 6 characters of a 43-
    /// character CSPRNG secret is not a meaningful head start on the rest.
    /// </summary>
    public const int DisplayPrefixLength = 10; // "tsk_" + 6

    /// <summary>
    /// The floor on writing <c>LastUsedAt</c>. An assistant issues one request per tool call and
    /// many per conversation; without a floor this column would be an UPDATE on every read of the
    /// user's own library.
    /// </summary>
    public static readonly TimeSpan LastUsedWriteInterval = TimeSpan.FromHours(1);

    /// <summary>Maximum length of the user-supplied label.</summary>
    public const int MaxNameLength = 60;

    /// <summary>
    /// How many live keys one account may hold. Not a security boundary — a cap so the list stays a
    /// list, and so a looping client cannot mint rows without end.
    /// </summary>
    public const int MaxKeysPerUser = 10;

    /// <summary>
    /// A new key: <c>tsk_</c> followed by 32 CSPRNG bytes in unpadded base64url (43 chars).
    /// <para>
    /// base64url rather than the plain base64 <see cref="DeviceCodes.GenerateSecureToken"/> returns,
    /// because this string is copied by hand into JSON config files and occasionally into URLs;
    /// <c>+</c>, <c>/</c> and <c>=</c> survive neither reliably. 32 bytes is 256 bits — the same
    /// order as the SHA-256 that stores it, so the hash is the weaker half either way.
    /// </para>
    /// </summary>
    public static string Generate()
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Prefix + Base64Url(bytes);
    }

    /// <summary>True when this bearer should be resolved as a connect key rather than a JWT.</summary>
    public static bool LooksLikeKey(string? token) =>
        !string.IsNullOrEmpty(token) && token.StartsWith(Prefix, StringComparison.Ordinal);

    /// <summary>The clear-text head of a raw key, for display. Safe on short or malformed input.</summary>
    public static string DisplayPrefix(string rawKey) =>
        string.IsNullOrEmpty(rawKey)
            ? ""
            : rawKey[..Math.Min(DisplayPrefixLength, rawKey.Length)];

    /// <summary>Trim and cap a user-supplied label; empty becomes a neutral default rather than "".</summary>
    public static string NormalizeName(string? name)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length == 0) return "Assistant";
        return trimmed.Length <= MaxNameLength ? trimmed : trimmed[..MaxNameLength];
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
