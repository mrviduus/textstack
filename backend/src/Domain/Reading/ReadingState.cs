namespace Domain.Reading;

/// <summary>
/// Where one user is in one book (V2 table <c>reading_state</c>), in one file version
/// (<see cref="FileId"/>): the current position, and the frontier, the furthest point reached, which
/// moving back does not lower. Locators are opaque envelope JSON (ADR-031 "Locator schemes"); CFIs do
/// not sort, so each carries a fraction (0..1) that is compared instead.
/// </summary>
public class ReadingState
{
    public Guid FileId { get; set; }
    public string CurrentLocator { get; set; } = "";
    public decimal BookFraction { get; set; }
    public string? FrontierLocator { get; set; }
    public decimal? FrontierFraction { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>When the client recorded this state, by its clock.</summary>
    public DateTimeOffset ClientRecordedAt { get; set; }

    /// <summary>Set by the server when it accepts a state; ignored on write.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Set by the server: 1 on the first write, +1 on each accepted one; ignored on write.</summary>
    public long Revision { get; set; }
}
