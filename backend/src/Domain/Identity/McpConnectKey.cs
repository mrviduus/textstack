namespace Domain.Identity;

/// <summary>
/// A <c>tsk_…</c> MCP connect key (V2 table <c>mcp_access_keys</c>), stored hashed;
/// <see cref="Prefix"/> is the part the user sees to tell keys apart. A revoked key keeps its row:
/// it is the record that the key was turned off.
/// </summary>
public class McpConnectKey
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string KeyHash { get; set; } = "";
    public string Prefix { get; set; } = "";
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
