namespace Domain.Entities;

/// <summary>
/// One pass through <c>/oauth/authorize</c>: the validated request while the reader looks at the
/// consent screen, then the authorization code once they approve (ADR-017).
///
/// <para>A table rather than <c>IMemoryCache</c>: a deploy restarts the API, and a reader halfway
/// through consent would otherwise come back to "request not found"; and code redemption must be
/// single-use under a race, which a conditional <c>UPDATE … WHERE consumed_at IS NULL</c> gives for
/// free. Rows are short-lived and swept on each new authorize.</para>
/// </summary>
public class OAuthAuthorizationRequest
{
    /// <summary>The <c>req</c> id in the consent URL. Random (v4), unguessable.</summary>
    public Guid Id { get; set; }

    public string ClientId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string RedirectUri { get; set; } = "";
    public string? State { get; set; }

    /// <summary>PKCE S256 challenge (base64url SHA-256 of the verifier).</summary>
    public string CodeChallenge { get; set; } = "";

    /// <summary>RFC 8707 resource the token will be bound to (the MCP endpoint).</summary>
    public string Resource { get; set; } = "";
    public string Scope { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Consent must happen before this; on approval, reset to the code's expiry.</summary>
    public DateTimeOffset ExpiresAt { get; set; }

    /// <summary>Set on approve — the reader who granted access.</summary>
    public Guid? UserId { get; set; }

    /// <summary>SHA-256 hex of the authorization code. Set on approve.</summary>
    public string? CodeHash { get; set; }

    public DateTimeOffset? DeniedAt { get; set; }

    /// <summary>Set when the code is exchanged for tokens. Single-use marker.</summary>
    public DateTimeOffset? ConsumedAt { get; set; }
}
