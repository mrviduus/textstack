using System.Buffers.Text;
using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;
using Domain.Entities;

namespace Application.Auth;

/// <summary>
/// Pure helpers for the MCP OAuth authorization server (ADR-017): token shapes, PKCE, redirect
/// rules, scope and resource normalisation. No DB, no HTTP — the security-relevant decisions are
/// unit-testable on their own, the same reason <see cref="McpKeys"/> and <see cref="DeviceCodes"/>
/// exist. Hashing is <see cref="DeviceCodes.HashToken"/>, as everywhere else.
/// </summary>
public static class OAuth
{
    /// <summary>Access token prefix. Recognised by the auth middleware before any DB work.</summary>
    public const string AccessTokenPrefix = "tso_";

    public const string RefreshTokenPrefix = "tsr_";

    /// <summary>DCR-minted client ids. Only cosmetic — a client id is not a secret.</summary>
    public const string ClientIdPrefix = "tsc_";

    /// <summary>The one permission: "read and write your library".</summary>
    public const string LibraryScope = "library";

    public const string OfflineAccessScope = "offline_access";

    /// <summary>What the consent screen says the single scope means.</summary>
    public const string LibraryScopeDescription = "Read and write your library";

    public static readonly string[] SupportedScopes = [LibraryScope, OfflineAccessScope];

    public static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromHours(1);

    /// <summary>Sliding: every refresh pushes it out again.</summary>
    public static readonly TimeSpan RefreshTokenLifetime = TimeSpan.FromDays(90);

    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(5);

    /// <summary>How long the consent screen may sit open, sign-in included.</summary>
    public static readonly TimeSpan ConsentLifetime = TimeSpan.FromMinutes(30);

    /// <summary>How long a fetched CIMD document is trusted before it is fetched again.</summary>
    public static readonly TimeSpan MetadataDocumentCacheLifetime = TimeSpan.FromHours(24);

    /// <summary>Default redirect-host allowlist. Loopback is always allowed on top (Claude Code).</summary>
    public static readonly string[] DefaultAllowedRedirectHosts = ["claude.ai", "claude.com", "chatgpt.com"];

    /// <summary><paramref name="prefix"/> + 32 CSPRNG bytes, unpadded base64url (43 chars).</summary>
    public static string NewToken(string prefix)
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return prefix + Base64Url.EncodeToString(bytes);
    }

    public static bool LooksLikeAccessToken(string? token) =>
        !string.IsNullOrEmpty(token) && token.StartsWith(AccessTokenPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Which grant, if any, an access token authenticates: its hash, not revoked, not expired, and
    /// issued FOR <paramref name="resource"/> (the audience check, RFC 8707). One expression so the
    /// middleware's query and the unit test are the same rule.
    /// </summary>
    public static Expression<Func<OAuthGrant, bool>> LiveAccessToken(string hash, string resource, DateTimeOffset now) =>
        g => g.AccessTokenHash == hash
            && g.RevokedAt == null
            && g.AccessTokenExpiresAt > now
            && g.Resource == resource;

    /// <summary>A PKCE S256 challenge is base64url(SHA-256) = exactly 43 unreserved chars.</summary>
    public static bool IsValidCodeChallenge(string? challenge) =>
        challenge is { Length: 43 } && challenge.All(IsBase64UrlChar);

    /// <summary>
    /// RFC 7636 §4.6: base64url(SHA-256(ASCII(verifier))) must equal the stored challenge. The verifier
    /// itself must be 43–128 unreserved characters. Constant-time compare.
    /// </summary>
    public static bool VerifyPkce(string? verifier, string? challenge)
    {
        if (verifier is null || verifier.Length is < 43 or > 128 || !verifier.All(IsUnreservedChar))
            return false;
        if (!IsValidCodeChallenge(challenge))
            return false;

        var computed = Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(computed), Encoding.ASCII.GetBytes(challenge!));
    }

    /// <summary>
    /// May a client redirect here at all? https to an allowlisted host (exact match, no subdomains),
    /// or http(s) to loopback on any port (RFC 8252 §7.3 — native clients like Claude Code). Never a
    /// fragment, never userinfo.
    /// </summary>
    public static bool IsAllowedRedirect(string? redirectUri, IEnumerable<string> allowedHosts)
    {
        if (!Uri.TryCreate(redirectUri, UriKind.Absolute, out var uri)) return false;
        if (uri.Fragment.Length > 0 || uri.UserInfo.Length > 0) return false;

        if (IsLoopback(uri))
            return uri.Scheme is "http" or "https";

        return uri.Scheme == Uri.UriSchemeHttps
            && uri.IsDefaultPort
            && allowedHosts.Any(h => string.Equals(h, uri.Host, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Does the redirect_uri on this request match one the client registered? Exact string match —
    /// except loopback, where the port is ignored because a native client picks a free one per run.
    /// </summary>
    public static bool RedirectMatches(string requested, IEnumerable<string> registered)
    {
        foreach (var candidate in registered)
        {
            if (string.Equals(requested, candidate, StringComparison.Ordinal)) return true;

            if (Uri.TryCreate(requested, UriKind.Absolute, out var a)
                && Uri.TryCreate(candidate, UriKind.Absolute, out var b)
                && IsLoopback(a) && IsLoopback(b)
                && a.Scheme == b.Scheme
                && string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase)
                && a.PathAndQuery == b.PathAndQuery)
                return true;
        }
        return false;
    }

    /// <summary>
    /// The scope actually granted. There is one permission, so <c>library</c> is always in it;
    /// <c>offline_access</c> is echoed when asked for. Anything else (e.g. <c>openid</c>) is dropped
    /// rather than refused — RFC 6749 §3.3 lets the server grant less than requested.
    /// </summary>
    public static string GrantedScope(string? requested)
    {
        var asked = (requested ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return asked.Contains(OfflineAccessScope, StringComparer.Ordinal)
            ? $"{LibraryScope} {OfflineAccessScope}"
            : LibraryScope;
    }

    /// <summary>
    /// RFC 8707: a client may name the resource it wants the token for. Absent means "the only one we
    /// have". Present must be that one; a trailing slash is tolerated because users type URLs.
    /// </summary>
    public static bool ResourceMatches(string? requested, string expected) =>
        string.IsNullOrEmpty(requested)
        || string.Equals(requested.TrimEnd('/'), expected.TrimEnd('/'), StringComparison.Ordinal);

    /// <summary>Appends query parameters to a redirect URI that may already carry a query.</summary>
    public static string AppendQuery(string uri, params (string Key, string? Value)[] parameters)
    {
        var sb = new StringBuilder(uri);
        var separator = uri.Contains('?') ? '&' : '?';
        foreach (var (key, value) in parameters)
        {
            if (value is null) continue;
            sb.Append(separator).Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(value));
            separator = '&';
        }
        return sb.ToString();
    }

    /// <summary>Host of a redirect URI for display ("claude.ai"), or the raw value if unparseable.</summary>
    public static string DisplayHost(string redirectUri) =>
        Uri.TryCreate(redirectUri, UriKind.Absolute, out var uri) ? uri.Host : redirectUri;

    private static bool IsLoopback(Uri uri) =>
        uri.Host is "localhost" or "127.0.0.1" or "[::1]";

    private static bool IsBase64UrlChar(char c) =>
        c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_';

    // RFC 7636 §4.1: ALPHA / DIGIT / "-" / "." / "_" / "~"
    private static bool IsUnreservedChar(char c) => IsBase64UrlChar(c) || c is '.' or '~';
}
