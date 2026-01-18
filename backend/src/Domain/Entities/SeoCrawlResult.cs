namespace Domain.Entities;

public class SeoCrawlResult
{
    public Guid Id { get; set; }
    public Guid JobId { get; set; }
    public required string Url { get; set; }
    public required string UrlType { get; set; }  // "book", "author", "genre"

    public int? StatusCode { get; set; }
    public string? ContentType { get; set; }
    public int? HtmlBytes { get; set; }

    public string? Title { get; set; }
    public string? MetaDescription { get; set; }
    public string? H1 { get; set; }
    public string? Canonical { get; set; }
    public string? MetaRobots { get; set; }
    public string? XRobotsTag { get; set; }

    public DateTimeOffset FetchedAt { get; set; }
    public string? FetchError { get; set; }

    public SeoCrawlJob Job { get; set; } = null!;
}
