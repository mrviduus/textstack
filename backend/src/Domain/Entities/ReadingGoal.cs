namespace Domain.Entities;

public class ReadingGoal
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public required string GoalType { get; set; } // "daily_minutes" | "books_per_year"
    public int TargetValue { get; set; }
    public int Year { get; set; } // 0 = recurring
    public bool IsActive { get; set; }
    public int StreakMinMinutes { get; set; } = 5; // configurable streak threshold
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
}
