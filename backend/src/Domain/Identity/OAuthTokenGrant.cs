namespace Domain.Identity;

/// <summary>
/// What a connected MCP client holds (V2 table <c>oauth_grants</c>): the hashes of its access and
/// refresh tokens, rotated together. <see cref="PreviousRefreshTokenHash"/> is the refresh token it
/// was rotated from, so a spent refresh token presented again is recognised as reuse.
/// </summary>
public class OAuthTokenGrant
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string ClientId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string RedirectUri { get; set; } = "";
    public string Resource { get; set; } = "";
    public string Scope { get; set; } = "";
    public string AccessTokenHash { get; set; } = "";
    public DateTimeOffset AccessTokenExpiresAt { get; set; }
    public string RefreshTokenHash { get; set; } = "";
    public DateTimeOffset RefreshTokenExpiresAt { get; set; }
    public string? PreviousRefreshTokenHash { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
