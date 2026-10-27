using Domain.Enums;

namespace Domain.Entities;

public class IngestionJob
{
    public Guid Id { get; set; }
    public Guid EditionId { get; set; }
    public Guid BookFileId { get; set; }
    public required string TargetLanguage { get; set; }
    public JobStatus Status { get; set; }
    public int AttemptCount { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }

    // Extraction diagnostics (persisted after extraction)
    public string? SourceFormat { get; set; }
    public int? UnitsCount { get; set; }
    public string? TextSource { get; set; }
    public double? Confidence { get; set; }
    public string? WarningsJson { get; set; }

    public Edition Edition { get; set; } = null!;
    public BookFile BookFile { get; set; } = null!;
}
