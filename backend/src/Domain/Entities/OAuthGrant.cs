namespace Domain.Entities;

/// <summary>
/// A reader's standing permission for one OAuth client — "Claude can read and write your library" —
/// and the current token pair behind it (ADR-017). One row per approved connection; what the
/// "Connected apps" list shows and what revoking switches off.
///
/// <para><b>Opaque, hashed tokens</b>, like <see cref="McpAccessKey"/>: only SHA-256 hex is stored.
/// Access (<c>tso_</c>) lives an hour; refresh (<c>tsr_</c>) rotates on every use and slides 90 days.
/// Presenting the refresh token that was just rotated away revokes the whole grant (reuse detection).</para>
///
/// <para><b>Revoked, not deleted</b> — the row survives as the record that access was withdrawn.
/// The auth middleware checks <see cref="RevokedAt"/> in the lookup query, so revocation is
/// immediate.</para>
/// </summary>
public class OAuthGrant
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    public string ClientId { get; set; } = "";

    /// <summary>Copied from the client at approval, so the list survives a CIMD document changing.</summary>
    public string ClientName { get; set; } = "";

    /// <summary>The redirect URI consent was given for; its host is what the list displays.</summary>
    public string RedirectUri { get; set; } = "";

    /// <summary>Audience (RFC 8707). The middleware only accepts the token for this resource.</summary>
    public string Resource { get; set; } = "";
    public string Scope { get; set; } = "";

    public string AccessTokenHash { get; set; } = "";
    public DateTimeOffset AccessTokenExpiresAt { get; set; }
    public string RefreshTokenHash { get; set; } = "";
    public DateTimeOffset RefreshTokenExpiresAt { get; set; }

    /// <summary>
    /// Hash of the refresh token this one replaced. If it is ever presented again, someone else holds
    /// the chain and the whole grant is revoked (refresh-reuse detection).
    /// </summary>
    public string? PreviousRefreshTokenHash { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Throttled like <see cref="McpAccessKey.LastUsedAt"/> — a coarse "recently".</summary>
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }

    public User User { get; set; } = null!;
}
