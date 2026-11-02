using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 MCP connect keys (table <c>mcp_access_keys</c>). The reader's methods are scoped to
/// <c>userId</c> (docs/01-architecture/data-access.md rule 7); the lookup by hash is not, the hash
/// being the credential.
/// </summary>
public interface IMcpKeyRepository
{
    /// <summary>The user's keys, revoked ones included (the row is the record of the revocation), newest first.</summary>
    Task<IReadOnlyList<McpConnectKey>> ListAsync(Guid userId, CancellationToken ct);

    /// <summary>How many of the user's keys are not revoked: the cap is the caller's.</summary>
    Task<int> CountLiveAsync(Guid userId, CancellationToken ct);

    /// <summary>Stores a new key of the user and returns it.</summary>
    Task<McpConnectKey> CreateAsync(Guid userId, string name, string keyHash, string prefix, CancellationToken ct);

    /// <summary>Revokes one of the user's keys; an already revoked one keeps its original time. False when not the user's.</summary>
    Task<bool> RevokeAsync(Guid userId, Guid keyId, CancellationToken ct);

    /// <summary>The unrevoked key with this hash; null when none.</summary>
    Task<McpConnectKey?> GetLiveByHashAsync(string keyHash, CancellationToken ct);

    /// <summary>Records that a key was used now; the caller throttles.</summary>
    Task TouchAsync(Guid keyId, CancellationToken ct);
}
