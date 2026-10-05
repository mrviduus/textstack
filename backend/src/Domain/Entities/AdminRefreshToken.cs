namespace Domain.Entities;

public class AdminRefreshToken
{
    public Guid Id { get; set; }
    public Guid AdminUserId { get; set; }

    /// <summary>SHA-256 hex of the refresh token (<c>DeviceCodes.HashToken</c>). The raw value is only ever sent to the client.</summary>
    public required string TokenHash { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public AdminUser AdminUser { get; set; } = null!;
}
