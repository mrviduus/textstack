namespace Domain.Identity;

/// <summary>A password reset code (V2 table <c>password_reset_tokens</c>), stored hashed; single use, short-lived.</summary>
public class PasswordReset
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public bool Used { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
