using Domain.Enums;

namespace Domain.Entities;

public class UserBookFile
{
    public Guid Id { get; set; }
    public Guid UserBookId { get; set; }
    public required string OriginalFileName { get; set; }
    public required string StoragePath { get; set; }
    public BookFormat Format { get; set; }
    public string? Sha256 { get; set; }
    public long FileSize { get; set; }
    public DateTimeOffset UploadedAt { get; set; }

    public UserBook UserBook { get; set; } = null!;
}
