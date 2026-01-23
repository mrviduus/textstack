using TextStack.Search.Providers.PostgresFts;

namespace TextStack.Search.Configuration;

/// <summary>
/// PostgreSQL Full-Text Search provider configuration.
/// </summary>
public sealed class PostgresFtsOptions
{
    /// <summary>
    /// Configuration section name for binding.
    /// </summary>
    public const string SectionName = "Search:PostgresFts";

    /// <summary>
    /// PostgreSQL connection string.
    /// If not set, uses the default application connection string.
    /// </summary>
    public string? ConnectionString { get; set; }

    /// <summary>
    /// Table name for search documents.
    /// Default: uses existing chapters table.
    /// </summary>
    public string? TableName { get; set; }

    /// <summary>
    /// Highlight options for ts_headline.
    /// </summary>
    public HighlightOptions Highlights { get; set; } = HighlightOptions.Default;

    /// <summary>
    /// Minimum similarity threshold for fuzzy matching (0.0 to 1.0).
    /// Lower values = more lenient matching. Default: 0.3
    /// </summary>
    public float FuzzyThreshold { get; set; } = 0.3f;
}
