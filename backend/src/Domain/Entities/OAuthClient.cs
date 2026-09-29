namespace Domain.Entities;

/// <summary>
/// An OAuth client that may ask a reader for access to their library over MCP (ADR-017). Always a
/// PUBLIC client — Claude and ChatGPT run PKCE with no secret — so there is no secret column.
///
/// <para>Two ways a row appears. <b>DCR</b> (<c>POST /oauth/register</c>, RFC 7591): we mint
/// <see cref="ClientId"/>. <b>CIMD</b> (Client ID Metadata Document): the client_id IS an https URL
/// the client hosts; we fetch it and cache the result here, refetching when <see cref="FetchedAt"/>
/// is stale. Same table so the authorize path resolves both with one lookup.</para>
/// </summary>
public class OAuthClient
{
    public Guid Id { get; set; }

    /// <summary>Minted id (DCR) or the metadata document URL (CIMD). Unique.</summary>
    public string ClientId { get; set; } = "";

    /// <summary>Shown on the consent screen and in "Connected apps". Client-supplied — never trusted
    /// alone; the consent screen shows the redirect host beside it.</summary>
    public string ClientName { get; set; } = "";

    /// <summary>Exact redirect URIs the client may use. Every one passed the host allowlist.</summary>
    public string[] RedirectUris { get; set; } = [];

    /// <summary>True when <see cref="ClientId"/> is a CIMD URL rather than a DCR-minted id.</summary>
    public bool IsMetadataDocument { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>CIMD only: when the document was last fetched. Null for DCR.</summary>
    public DateTimeOffset? FetchedAt { get; set; }
}
