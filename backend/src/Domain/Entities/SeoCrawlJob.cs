using Domain.Enums;

namespace Domain.Entities;

public class SeoCrawlJob
{
    public Guid Id { get; set; }
    public Guid SiteId { get; set; }
    public int MaxPages { get; set; } = 500;
    public int Concurrency { get; set; } = 4;
    public int CrawlDelayMs { get; set; } = 200;
    public string UserAgent { get; set; } = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

    public SeoCrawlJobStatus Status { get; set; } = SeoCrawlJobStatus.Queued;
    public int TotalUrls { get; set; }
    public int PagesCrawled { get; set; }
    public int ErrorsCount { get; set; }
    public string? Error { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }

    public Site Site { get; set; } = null!;
    public ICollection<SeoCrawlResult> Results { get; set; } = [];
}
