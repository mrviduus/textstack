namespace Contracts.Mcp;

/// <summary>One connect key as the reader sees it. Never carries the key itself — only its head.</summary>
public record McpKeyDto(
    Guid Id,
    string Name,
    string Prefix,
    DateTimeOffset CreatedAt,
    /// <summary>Null until the key has authenticated a request. Written at most hourly, so it means
    /// "recently", not "exactly then". This is the field that tells a reader whether the connector
    /// they just configured is actually reaching us.</summary>
    DateTimeOffset? LastUsedAt,
    DateTimeOffset? RevokedAt);

public record CreateMcpKeyRequest(string? Name);

/// <summary>
/// The only response that ever carries <see cref="Key"/>. It is not recoverable afterwards — the
/// server keeps a SHA-256 of it and nothing else — so the client must present it as copy-it-now.
/// </summary>
public record CreateMcpKeyResponse(
    Guid Id,
    string Name,
    string Key,
    string Prefix,
    DateTimeOffset CreatedAt);
