namespace Domain.Entities;

public class Highlight
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid EditionId { get; set; }
    public Guid ChapterId { get; set; }
    public required string AnchorJson { get; set; }
    public required string Color { get; set; }
    public required string SelectedText { get; set; }
    public string? NoteText { get; set; }
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition Edition { get; set; } = null!;
    public Chapter Chapter { get; set; } = null!;
    public Note? Note { get; set; }
}
