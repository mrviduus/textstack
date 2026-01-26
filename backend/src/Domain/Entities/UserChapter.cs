namespace Domain.Entities;

public class UserChapter
{
    public Guid Id { get; set; }
    public Guid UserBookId { get; set; }
    public int ChapterNumber { get; set; }
    public required string Title { get; set; }
    public required string Html { get; set; }
    public required string PlainText { get; set; }
    public int? WordCount { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public UserBook UserBook { get; set; } = null!;
}
