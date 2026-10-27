using Domain.Enums;

namespace Domain.Entities;

public class BookFile
{
    public Guid Id { get; set; }
    public Guid EditionId { get; set; }
    public required string OriginalFileName { get; set; }
    public required string StoragePath { get; set; }
    public BookFormat Format { get; set; }
    public DateTimeOffset UploadedAt { get; set; }

    public Edition Edition { get; set; } = null!;
    public ICollection<IngestionJob> IngestionJobs { get; set; } = [];
}
