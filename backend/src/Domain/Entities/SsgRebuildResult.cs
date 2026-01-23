namespace Domain.Entities;

public class SsgRebuildResult
{
    public Guid Id { get; set; }
    public Guid JobId { get; set; }

    public string Route { get; set; } = "";
    public string RouteType { get; set; } = "";
    public bool Success { get; set; }
    public int? RenderTimeMs { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset RenderedAt { get; set; }

    public SsgRebuildJob Job { get; set; } = null!;
}
