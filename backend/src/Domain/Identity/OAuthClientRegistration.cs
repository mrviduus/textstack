namespace Domain.Identity;

/// <summary>
/// A registered MCP OAuth client (V2 table <c>oauth_clients</c>, ADR-017), shared by every user who
/// connects it: one minted by dynamic registration, or a fetched client metadata document
/// (<see cref="IsMetadataDocument"/>, whose <see cref="ClientId"/> is its URL).
/// </summary>
public class OAuthClientRegistration
{
    public Guid Id { get; set; }
    public string ClientId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string[] RedirectUris { get; set; } = [];
    public bool IsMetadataDocument { get; set; }

    /// <summary>When a metadata document was last fetched; null for a registered client.</summary>
    public DateTimeOffset? FetchedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
