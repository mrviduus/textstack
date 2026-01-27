using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Advanced dash handling.
/// Ported from Standard Ebooks typography.py.
/// </summary>
public static partial class Dashes
{
    public const char EmDash = '\u2014';
    public const char TwoEmDash = '\u2E3A';
    public const char ThreeEmDash = '\u2E3B';
    public const char WordJoiner = '\u2060';
    public const char EnDash = '\u2013';
    public const char HorizontalBar = '\u2015';

    /// <summary>
    /// Process dashes: horizontal bar → em dash, multi-em dashes, word joiner insertion.
    /// </summary>
    public static string ProcessDashes(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Replace horizontal bar with em dash
        html = html.Replace(HorizontalBar, EmDash);

        // Sequential em dashes to Unicode multi-em characters
        // Must be in order: three first, then two
        html = html.Replace("\u2014\u2014\u2014", ThreeEmDash.ToString());
        html = html.Replace("\u2014\u2014", TwoEmDash.ToString());

        // Sequential hyphens to em dash (common OCR/typing error)
        html = TripleHyphenRegex().Replace(html, ThreeEmDash.ToString());
        html = DoubleHyphenRegex().Replace(html, EmDash.ToString());

        // Add word joiner before em dashes (prevents line break before dash)
        // Don't add if already has word joiner, nbsp, or hair space
        html = BeforeEmDashRegex().Replace(html, "$1" + WordJoiner + "$2");

        // Add word joiner around en dashes in number ranges
        html = AroundEnDashRegex().Replace(html, WordJoiner.ToString() + EnDash + WordJoiner);

        // Fix em dash adjacent to quotes (smartypants issue)
        // —" followed by letter should be —"letter
        html = EmDashCloseQuoteRegex().Replace(html, EmDash + "\u201C$1");
        html = EmDashCloseApostropheRegex().Replace(html, EmDash + "\u2018$1");

        return html;
    }

    /// <summary>
    /// Remove word joiners from a string (for alt text, titles, etc.)
    /// </summary>
    public static string RemoveWordJoiners(string text)
    {
        return text.Replace(WordJoiner.ToString(), "");
    }

    // Triple hyphen → three-em dash (not inside tags)
    [GeneratedRegex(@"(?<!<[^>]*)---(?![^<]*>)")]
    private static partial Regex TripleHyphenRegex();

    // Double hyphen → em dash (not inside tags)
    [GeneratedRegex(@"(?<!<[^>]*)--(?![^<]*>)")]
    private static partial Regex DoubleHyphenRegex();

    // Add word joiner before em/three-em dash if not already present
    [GeneratedRegex(@"([^\s\u2060\u00A0\u200A])([\u2014\u2E3B])")]
    private static partial Regex BeforeEmDashRegex();

    // Normalize word joiner around en dash
    [GeneratedRegex(@"\u2060?\u2013\u2060?")]
    private static partial Regex AroundEnDashRegex();

    // Fix em dash + close quote + letter (smartypants error)
    [GeneratedRegex(@"\u2014\u201D(\p{L})")]
    private static partial Regex EmDashCloseQuoteRegex();

    // Fix em dash + close apostrophe + letter
    [GeneratedRegex(@"\u2014\u2019(\p{L})")]
    private static partial Regex EmDashCloseApostropheRegex();
}
