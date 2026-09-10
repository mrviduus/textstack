namespace Domain.Entities;

/// <summary>
/// A long-lived credential a reader pastes into their AI client to connect it to TextStack.
///
/// <para><b>Why this exists.</b> The MCP bridge has two transports. The local one (stdio) runs the
/// device flow itself, caches an access+refresh pair and refreshes on its own, so it stays connected
/// indefinitely. The remote one (<c>textstack.app/mcp</c>) is stateless and multi-user: it reads a
/// bearer off each request and has nowhere to keep a refresh token, so the only credential it could
/// take was an access token — which expires in <c>Jwt:AccessTokenExpiryMinutes</c> (60). A connector
/// configured with one dies within the hour, and reconnecting meant installing a .NET CLI, running a
/// device flow in a terminal and copying a JWT out of a cache file. That is not a thing a reader can
/// do, and it is not a thing anyone can do from a phone.</para>
///
/// <para><b>Hashed, like the other secrets that are done right.</b> Only the SHA-256 hex of the key
/// is stored (<see cref="Application.Auth.DeviceCodes.HashToken"/>, the same helper behind
/// <c>PasswordResetToken.TokenHash</c> and <c>DeviceAuthorization.DeviceCodeHash</c>). The raw key is
/// returned exactly once, at creation, and is unrecoverable afterwards. A fast hash is correct here
/// and BCrypt would be wrong: this is 32 bytes of CSPRNG output, not a human-chosen password, so
/// there is no dictionary to slow down — only a per-request cost to pay.</para>
///
/// <para><b>Revoked, not deleted.</b> <see cref="RevokedAt"/> keeps the row so "this key was turned
/// off, on this date" survives. <c>UserRefreshToken</c> deletes on revoke and therefore cannot answer
/// that question after a suspected compromise.</para>
///
/// <para><b>No expiry by design.</b> A credential that silently stops working is the exact failure
/// this entity was created to end. Control is <see cref="RevokedAt"/> plus
/// <see cref="LastUsedAt"/> — the reader can see which keys are live and switch off the ones that
/// are not.</para>
/// </summary>
public class McpAccessKey : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }

    /// <summary>
    /// What the reader called it — "Claude Desktop", "ChatGPT on my phone". Display only; the list
    /// is otherwise indistinguishable rows of dates, and a key you cannot identify is a key you will
    /// not revoke.
    /// </summary>
    public string Name { get; set; } = "";

    /// <summary>SHA-256 hex of the raw key. The only copy of it that survives creation.</summary>
    public string KeyHash { get; set; } = "";

    /// <summary>
    /// The first few characters of the raw key, stored in clear. Enough to match a row against the
    /// string in a config file, far too little to authenticate with.
    /// </summary>
    public string Prefix { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>
    /// Last time this key authenticated a request, or null if it never has — which is the single
    /// most useful thing on the page: it says whether the connector the reader just configured is
    /// actually talking to us.
    /// <para>
    /// Written at most hourly (<see cref="Application.Auth.McpKeys.LastUsedWriteInterval"/>), not per
    /// request: an assistant makes many tool calls per conversation and each is a request. The
    /// throttle is why this is a coarse "recently" rather than a precise timestamp.
    /// </para>
    /// </summary>
    public DateTimeOffset? LastUsedAt { get; set; }

    /// <summary>Set when the reader revokes it. A revoked key authenticates nothing, from that moment.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
}
