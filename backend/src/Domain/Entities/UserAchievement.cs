namespace Domain.Entities;

public class UserAchievement
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public required string AchievementCode { get; set; }
    public DateTimeOffset UnlockedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
}
