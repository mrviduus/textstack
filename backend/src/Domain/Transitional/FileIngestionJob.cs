namespace Domain.Transitional;

/// <summary>
/// A server extraction job for one uploaded file version (V2 table <c>ingestion_jobs</c>). Named apart
/// from the legacy catalog <c>Domain.Entities.IngestionJob</c>. Transitional: dropped at M6.4 (ADR-031).
/// </summary>
public class FileIngestionJob
{
    public const string Queued = "queued";
    public const string Processing = "processing";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";

    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }
    public Guid FileId { get; set; }

    /// <summary><see cref="Queued"/>, <see cref="Processing"/>, <see cref="Succeeded"/> or <see cref="Failed"/>.</summary>
    public string Status { get; set; } = Queued;

    /// <summary>How many runs claimed it; a claim counts before the run starts.</summary>
    public int AttemptCount { get; set; }

    public string? Error { get; set; }

    /// <summary>What the extractor detected: <c>epub</c>, <c>pdf</c>, <c>html</c>, <c>fb2</c> or <c>unknown</c>.</summary>
    public string? SourceFormat { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
}
