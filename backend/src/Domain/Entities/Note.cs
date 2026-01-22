namespace Domain.Entities;

// TODO: Notes feature partially implemented - entity/DB exists but API endpoints not wired.
// Relationships: User, Site, Edition, Chapter - keep entity, implement API later.
public class Note
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid EditionId { get; set; }
    public Guid ChapterId { get; set; }
    public required string Locator { get; set; }
    public required string Text { get; set; }
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition Edition { get; set; } = null!;
    public Chapter Chapter { get; set; } = null!;
}
