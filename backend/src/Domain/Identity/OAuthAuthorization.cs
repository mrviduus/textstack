namespace Domain.Identity;

/// <summary>
/// A pending MCP OAuth authorization (V2 table <c>oauth_authorization_requests</c>, PKCE): created by
/// the authorize redirect, approved (<see cref="UserId"/> and <see cref="CodeHash"/> set) or denied on
/// the consent page, and spent (<see cref="ConsumedAt"/>) by the first redemption of its code.
/// </summary>
public class OAuthAuthorization
{
    public Guid Id { get; set; }
    public string ClientId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string RedirectUri { get; set; } = "";
    public string? State { get; set; }
    public string CodeChallenge { get; set; } = "";
    public string Resource { get; set; } = "";
    public string Scope { get; set; } = "";

    /// <summary>The consent deadline while pending; the code's deadline once approved.</summary>
    public DateTimeOffset ExpiresAt { get; set; }

    /// <summary>Who approved it; null while pending or denied.</summary>
    public Guid? UserId { get; set; }

    public string? CodeHash { get; set; }
    public DateTimeOffset? DeniedAt { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
