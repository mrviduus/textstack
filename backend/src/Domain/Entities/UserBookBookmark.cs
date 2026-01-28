namespace Domain.Entities;

public class UserBookBookmark
{
    public Guid Id { get; set; }
    public Guid UserBookId { get; set; }
    public Guid ChapterId { get; set; }
    public required string Locator { get; set; }
    public string? Title { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public UserBook UserBook { get; set; } = null!;
    public UserChapter Chapter { get; set; } = null!;
}
