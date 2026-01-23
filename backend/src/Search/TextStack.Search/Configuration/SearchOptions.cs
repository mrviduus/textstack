namespace TextStack.Search.Configuration;

/// <summary>
/// General search configuration options.
/// </summary>
public sealed class SearchOptions
{
    /// <summary>
    /// Configuration section name for binding.
    /// </summary>
    public const string SectionName = "Search";

    /// <summary>
    /// Default number of results per search request.
    /// </summary>
    public int DefaultLimit { get; set; } = 20;

    /// <summary>
    /// Maximum allowed results per search request.
    /// </summary>
    public int MaxLimit { get; set; } = 100;

    /// <summary>
    /// Enable highlights in search results by default.
    /// </summary>
    public bool EnableHighlights { get; set; } = true;

    /// <summary>
    /// Minimum prefix length for autocomplete suggestions.
    /// </summary>
    public int MinSuggestionPrefixLength { get; set; } = 2;

    /// <summary>
    /// Default number of autocomplete suggestions.
    /// </summary>
    public int DefaultSuggestionLimit { get; set; } = 10;
}
