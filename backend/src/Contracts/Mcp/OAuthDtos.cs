namespace Contracts.Mcp;

/// <summary>
/// What the consent page shows: <c>GET /oauth/requests/{id}</c>. <see cref="Status"/> is
/// <c>pending</c> | <c>approved</c> | <c>denied</c> | <c>expired</c>; only <c>pending</c> can be acted on.
/// </summary>
public record OAuthConsentRequestDto(
    Guid Id,
    string ClientName,
    string ClientId,
    string RedirectHost,
    string Scope,
    string ScopeDescription,
    string Status,
    DateTimeOffset ExpiresAt);

/// <summary>Body of <c>POST /oauth/authorize/approve</c> and <c>/deny</c>.</summary>
public record OAuthDecisionRequest(Guid RequestId);

/// <summary>Where the browser goes next — the client's redirect URI with code (or error), state and iss.</summary>
public record OAuthDecisionResponse(string Redirect);

/// <summary>One "Connected apps" row: <c>GET /me/oauth/grants</c>.</summary>
public record OAuthGrantDto(
    Guid Id,
    string ClientName,
    string RedirectHost,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastUsedAt);
