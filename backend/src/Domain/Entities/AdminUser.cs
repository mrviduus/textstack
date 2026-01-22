using Domain.Enums;

namespace Domain.Entities;

public class AdminUser
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public required string PasswordHash { get; set; }
    public AdminRole Role { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public ICollection<AdminRefreshToken> RefreshTokens { get; set; } = [];
}
