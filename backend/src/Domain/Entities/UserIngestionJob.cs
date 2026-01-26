using Domain.Enums;

namespace Domain.Entities;

public class UserIngestionJob
{
    public Guid Id { get; set; }
    public Guid UserBookId { get; set; }
    public Guid UserBookFileId { get; set; }
    public JobStatus Status { get; set; }
    public int AttemptCount { get; set; }
    public string? Error { get; set; }
    public string? SourceFormat { get; set; }
    public int? UnitsCount { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }

    public UserBook UserBook { get; set; } = null!;
    public UserBookFile UserBookFile { get; set; } = null!;
}
