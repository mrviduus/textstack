using Domain.Enums;

namespace Domain.Entities;

public class SsgRebuildJob
{
    public Guid Id { get; set; }
    public Guid SiteId { get; set; }

    public SsgRebuildMode Mode { get; set; } = SsgRebuildMode.Full;
    public int Concurrency { get; set; } = 4;
    public int TimeoutMs { get; set; } = 30000;

    // For Specific mode - JSON arrays of slugs
    public string? BookSlugsJson { get; set; }
    public string? AuthorSlugsJson { get; set; }
    public string? GenreSlugsJson { get; set; }

    // Progress
    public SsgRebuildJobStatus Status { get; set; } = SsgRebuildJobStatus.Queued;
    public int TotalRoutes { get; set; }
    public int RenderedCount { get; set; }
    public int FailedCount { get; set; }
    public string? Error { get; set; }

    // Timestamps
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }

    // Relations
    public Site Site { get; set; } = null!;
    public ICollection<SsgRebuildResult> Results { get; set; } = [];
}
