namespace Domain.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public string? Name { get; set; }
    public string? Picture { get; set; }
    public required string GoogleSubject { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public ICollection<ReadingProgress> ReadingProgresses { get; set; } = [];
    public ICollection<Bookmark> Bookmarks { get; set; } = [];
    public ICollection<Note> Notes { get; set; } = [];
    public ICollection<UserLibrary> UserLibraries { get; set; } = [];
}
