namespace Domain.Entities;

public class UserRefreshToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    /// <summary>SHA-256 hex of the refresh token (<c>DeviceCodes.HashToken</c>). The raw value is only ever sent to the client.</summary>
    public required string TokenHash { get; set; }

    /// <summary>Hash of the token this one replaced on rotation. Presenting that one again revokes this one (reuse detection).</summary>
    public string? PreviousTokenHash { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public User User { get; set; } = null!;
}
