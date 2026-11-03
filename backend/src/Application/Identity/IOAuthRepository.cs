using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 MCP OAuth server's state (ADR-017; tables <c>oauth_clients</c>,
/// <c>oauth_authorization_requests</c>, <c>oauth_grants</c>). Clients are shared by all users;
/// requests belong to a user once approved; grants always do. Lookups by a token or code hash are
/// not scoped to a user (the hash is the credential); the sweeps are cross-user system operations.
/// </summary>
public interface IOAuthRepository
{
    /// <summary>The client registered under <paramref name="clientId"/>; null when none.</summary>
    Task<OAuthClientRegistration?> GetClientAsync(string clientId, CancellationToken ct);

    /// <summary>
    /// Registers a client, or refreshes the one under its <c>ClientId</c> (name, redirect URIs, fetch
    /// time: a metadata document fetched again). Returns the stored row.
    /// </summary>
    Task<OAuthClientRegistration> SaveClientAsync(OAuthClientRegistration client, CancellationToken ct);

    Task CreateRequestAsync(OAuthAuthorization request, CancellationToken ct);

    /// <summary>The request; null when none.</summary>
    Task<OAuthAuthorization?> GetRequestAsync(Guid requestId, CancellationToken ct);

    /// <summary>
    /// Approves a pending request (not denied, not approved, not expired at <paramref name="now"/>):
    /// binds it to the user and gives it the code's hash and deadline. Returns it; null when it was
    /// not pending, or the user's password was reset after <paramref name="tokenIssuedAt"/> (the
    /// <c>iat</c> of the access token consenting; a reset committing meanwhile included).
    /// </summary>
    Task<OAuthAuthorization?> ApproveRequestAsync(
        Guid requestId, Guid userId, string codeHash, DateTimeOffset codeExpiresAt, DateTimeOffset tokenIssuedAt, DateTimeOffset now, CancellationToken ct);

    /// <summary>Denies a request pending at <paramref name="now"/> (the same test as approval). False when it was not pending.</summary>
    Task<bool> DenyRequestAsync(Guid requestId, DateTimeOffset now, CancellationToken ct);

    /// <summary>The request a code was issued for; null when the code is unknown.</summary>
    Task<OAuthAuthorization?> GetRequestByCodeAsync(string codeHash, CancellationToken ct);

    /// <summary>
    /// Spends the request's code, before anything else about the redemption is checked: of two
    /// redemptions exactly one gets true, and a failed one still spends it. False when already spent.
    /// </summary>
    Task<bool> BurnCodeAsync(Guid requestId, CancellationToken ct);

    /// <summary>Deletes requests created before <paramref name="createdBefore"/>, whatever their state; returns how many.</summary>
    Task<int> DeleteRequestsCreatedBeforeAsync(DateTimeOffset createdBefore, CancellationToken ct);

    /// <summary>
    /// Stores the user's new grant and, atomically with it, revokes the user's live grants for
    /// the same app (same client name and redirect host: dynamic registration mints a new client id on
    /// every connect), so reconnecting replaces rather than adds. False (nothing stored) unless
    /// <paramref name="requestId"/> is a request the user approved, requested after the user's last
    /// password reset (a reset committing meanwhile included): a pre-reset consent mints no grant.
    /// </summary>
    Task<bool> ConnectAsync(Guid userId, Guid requestId, OAuthTokenGrant grant, CancellationToken ct);

    /// <summary>The unrevoked grant holding this refresh token (expired or not); null when none.</summary>
    Task<OAuthTokenGrant?> GetByRefreshTokenAsync(string refreshTokenHash, CancellationToken ct);

    /// <summary>
    /// Reuse detection (RFC 9700 §4.14.2): <paramref name="refreshTokenHash"/> was already rotated
    /// away, so the live grant rotated from it is revoked, both its tokens. Returns how many.
    /// </summary>
    Task<int> RevokeOnRefreshReuseAsync(string refreshTokenHash, CancellationToken ct);

    /// <summary>
    /// Rotates both tokens of a live grant, provided it still holds <paramref name="oldRefreshTokenHash"/>:
    /// of two refreshes with one token exactly one wins. False when it lost or the grant was revoked.
    /// </summary>
    Task<bool> RotateAsync(
        Guid grantId, string oldRefreshTokenHash,
        string accessTokenHash, DateTimeOffset accessTokenExpiresAt,
        string refreshTokenHash, DateTimeOffset refreshTokenExpiresAt,
        CancellationToken ct);

    /// <summary>Revokes the live grant holding this access or refresh token (RFC 7009). Returns how many.</summary>
    Task<int> RevokeByTokenAsync(string tokenHash, CancellationToken ct);

    /// <summary>
    /// The grant an access token authenticates: unrevoked, unexpired at <paramref name="now"/>, and
    /// issued for <paramref name="resource"/> (the audience, RFC 8707). Null when none.
    /// </summary>
    Task<OAuthTokenGrant?> GetByAccessTokenAsync(string accessTokenHash, string resource, DateTimeOffset now, CancellationToken ct);

    /// <summary>Records that a grant was used now; the caller throttles.</summary>
    Task TouchAsync(Guid grantId, CancellationToken ct);

    /// <summary>The user's connected apps: unrevoked grants whose refresh token is alive at <paramref name="now"/>, newest first.</summary>
    Task<IReadOnlyList<OAuthTokenGrant>> ListLiveAsync(Guid userId, DateTimeOffset now, CancellationToken ct);

    /// <summary>
    /// Revokes one of the user's grants; an already revoked one keeps its original time. False when
    /// not the user's.
    /// </summary>
    Task<bool> RevokeAsync(Guid userId, Guid grantId, CancellationToken ct);

    /// <summary>Deletes grants revoked, or whose refresh token expired, before <paramref name="before"/>; returns how many.</summary>
    Task<int> DeleteDeadGrantsAsync(DateTimeOffset before, CancellationToken ct);
}
