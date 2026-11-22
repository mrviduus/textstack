namespace Application.Identity;

public class GoogleSettings
{
    public const string SectionName = "Google";

    public required string ClientId { get; set; }

    /// Comma-separated extra audiences accepted alongside ClientId.
    /// Lets us rotate the primary OAuth client without simultaneous
    /// mobile + backend redeploys: keep the old one here during the
    /// crossover window, drop once everyone is on the new build.
    public string? LegacyClientIds { get; set; }
}
