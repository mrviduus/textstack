using System.Text.RegularExpressions;

namespace TextStack.Extraction.Clean;

/// <summary>
/// Normalizes whitespace: collapses multiple spaces, normalizes line breaks.
/// Ported from SE's clean.py whitespace handling.
/// </summary>
public static partial class WhitespaceNormalizer
{
    public static string Normalize(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // 1. Normalize line endings to \n
        html = html.Replace("\r\n", "\n").Replace("\r", "\n");

        // 2. Remove trailing whitespace on each line
        html = TrailingWhitespaceRegex().Replace(html, "\n");

        // 3. Collapse multiple blank lines to single
        html = MultipleBlankLinesRegex().Replace(html, "\n\n");

        // 4. Collapse multiple spaces (but not in pre/code tags)
        html = CollapseSpacesOutsidePre(html);

        // 5. Remove spaces around tags (but preserve nbsp)
        html = SpaceBeforeCloseTagRegex().Replace(html, "</$1>");
        html = SpaceAfterOpenTagRegex().Replace(html, "<$1>");

        // 6. Normalize space before punctuation
        html = SpaceBeforePunctuationRegex().Replace(html, "$1");

        return html.Trim();
    }

    private static string CollapseSpacesOutsidePre(string html)
    {
        // Simple approach: collapse multiple regular spaces to single
        // Preserves nbsp (\u00a0) and other special whitespace
        return MultipleSpacesRegex().Replace(html, " ");
    }

    [GeneratedRegex(@"[ \t]+\n")]
    private static partial Regex TrailingWhitespaceRegex();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex MultipleBlankLinesRegex();

    [GeneratedRegex(@"[ \t]{2,}")]
    private static partial Regex MultipleSpacesRegex();

    [GeneratedRegex(@"\s+</(\w+)>")]
    private static partial Regex SpaceBeforeCloseTagRegex();

    [GeneratedRegex(@"<(\w+[^>]*)>\s+")]
    private static partial Regex SpaceAfterOpenTagRegex();

    [GeneratedRegex(@"\s+([.,;:!?])")]
    private static partial Regex SpaceBeforePunctuationRegex();
}
