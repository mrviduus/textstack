using System.Text.RegularExpressions;

namespace TextStack.Extraction.Clean;

/// <summary>
/// Removes empty HTML tags that add no semantic value.
/// Ported from SE's clean.py empty tag removal.
/// </summary>
public static partial class EmptyTagRemover
{
    // Tags that should be removed when empty
    private static readonly HashSet<string> RemovableTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "span", "p", "div", "em", "i", "b", "strong", "u", "s", "strike",
        "a", "font", "center", "blockquote"
    };

    // Tags that should never be removed even when empty
    private static readonly HashSet<string> PreserveTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "br", "hr", "img", "input", "meta", "link", "area", "base",
        "col", "embed", "param", "source", "track", "wbr",
        "td", "th", "tr", "tbody", "thead", "tfoot", "table",
        "iframe", "video", "audio", "canvas", "svg", "object"
    };

    public static string Remove(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        var prev = html;
        var maxIterations = 10; // Nested empty tags need multiple passes

        for (var i = 0; i < maxIterations; i++)
        {
            // Remove empty tags with only whitespace
            html = EmptyTagRegex().Replace(html, m =>
            {
                var tagName = m.Groups[1].Value.ToLowerInvariant();

                // Preserve certain tags even when empty
                if (PreserveTags.Contains(tagName))
                    return m.Value;

                // Only remove known removable tags
                if (!RemovableTags.Contains(tagName))
                    return m.Value;

                return string.Empty;
            });

            // Remove self-closing empty tags like <span/>
            html = SelfClosingEmptyTagRegex().Replace(html, m =>
            {
                var tagName = m.Groups[1].Value.ToLowerInvariant();

                if (PreserveTags.Contains(tagName))
                    return m.Value;

                if (!RemovableTags.Contains(tagName))
                    return m.Value;

                return string.Empty;
            });

            if (html == prev)
                break;
            prev = html;
        }

        // Clean up resulting multiple spaces
        html = MultipleSpacesRegex().Replace(html, " ");

        return html;
    }

    // Matches <tag>whitespace-only</tag> or <tag></tag>
    [GeneratedRegex(@"<(\w+)(?:\s+[^>]*)?>\s*</\1>", RegexOptions.IgnoreCase)]
    private static partial Regex EmptyTagRegex();

    // Matches <tag/> or <tag />
    [GeneratedRegex(@"<(\w+)\s*/>", RegexOptions.IgnoreCase)]
    private static partial Regex SelfClosingEmptyTagRegex();

    [GeneratedRegex(@"  +")]
    private static partial Regex MultipleSpacesRegex();
}
