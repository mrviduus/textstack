namespace TextStack.Extraction.TextProcessing.Configuration;

/// <summary>
/// Text processing options.
/// </summary>
public class TextProcessingOptions
{
    /// <summary>
    /// Enable spelling modernization (to-day -> today).
    /// </summary>
    public bool EnableSpelling { get; set; } = true;

    /// <summary>
    /// Enable typography (smart quotes, dashes).
    /// </summary>
    public bool EnableTypography { get; set; } = true;

    /// <summary>
    /// Enable semantic markup (abbr, roman numerals).
    /// </summary>
    public bool EnableSemantic { get; set; } = true;

    /// <summary>
    /// Default language.
    /// </summary>
    public string Language { get; set; } = "en";
}
