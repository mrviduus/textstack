using Domain.Enums;

namespace Domain.Entities;

public class SsgRebuildJob : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid SiteId { get; set; }

    public int Concurrency { get; set; } = 4;

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
}
