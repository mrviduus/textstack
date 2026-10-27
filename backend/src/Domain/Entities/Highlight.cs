namespace Domain.Entities;

public class Highlight : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid? EditionId { get; set; }
    public Guid? ChapterId { get; set; }
    public Guid? UserBookId { get; set; }
    public Guid? UserChapterId { get; set; }
    public required string AnchorJson { get; set; }
    public required string Color { get; set; }
    public required string SelectedText { get; set; }
    public string? NoteText { get; set; }
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? LastReviewedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition? Edition { get; set; }
    public Chapter? Chapter { get; set; }
    public UserBook? UserBook { get; set; }
    public UserChapter? UserChapter { get; set; }
}
