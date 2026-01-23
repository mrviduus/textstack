namespace TextStack.Search.Providers.PostgresFts;

/// <summary>
/// Configuration options for PostgreSQL ts_headline highlighting.
/// </summary>
public sealed record HighlightOptions
{
    /// <summary>
    /// HTML tag to wrap highlighted terms (start). Default: &lt;b&gt;
    /// </summary>
    public string StartSel { get; init; } = "<b>";

    /// <summary>
    /// HTML tag to wrap highlighted terms (end). Default: &lt;/b&gt;
    /// </summary>
    public string StopSel { get; init; } = "</b>";

    /// <summary>
    /// Maximum number of fragments to return. Default: 3
    /// </summary>
    public int MaxFragments { get; init; } = 3;

    /// <summary>
    /// Maximum words per fragment. Default: 35
    /// </summary>
    public int MaxWords { get; init; } = 35;

    /// <summary>
    /// Minimum words per fragment. Default: 15
    /// </summary>
    public int MinWords { get; init; } = 15;

    /// <summary>
    /// Fragment delimiter. Default: " ... "
    /// </summary>
    public string FragmentDelimiter { get; init; } = " ... ";

    /// <summary>
    /// Builds ts_headline options string for PostgreSQL.
    /// </summary>
    public string ToOptionsString() =>
        $"StartSel={StartSel}, StopSel={StopSel}, MaxFragments={MaxFragments}, MaxWords={MaxWords}, MinWords={MinWords}, FragmentDelimiter={FragmentDelimiter}";

    public static HighlightOptions Default => new();
}
