namespace Domain.Entities;

/// <summary>
/// Singleton settings for the SEO backfill poller. Row identified by fixed <see cref="FixedId"/>.
/// </summary>
public class SeoBackfillSettings
{
    /// <summary>Well-known singleton row id.</summary>
    public static readonly Guid FixedId = new("44444444-4444-4444-4444-444444444444");

    public Guid Id { get; set; } = FixedId;

    public bool Enabled { get; set; }

    public int JobsPerRun { get; set; } = 5;

    public int IntervalSeconds { get; set; } = 60;

    public DateTimeOffset UpdatedAt { get; set; }
}
