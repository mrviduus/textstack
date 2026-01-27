using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Removes empty HTML tags that add no semantic value.
/// </summary>
public class EmptyTagProcessor : ITextProcessor
{
    public string Name => "EmptyTag";
    public int Order => 300;

    private static readonly Regex EmptyTagRegex = new(@"<(\w+)(?:\s+[^>]*)?>\s*</\1>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SelfClosingEmptyTagRegex = new(@"<(\w+)\s*/>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex MultipleSpacesRegex = new(@"  +", RegexOptions.Compiled);

    private static readonly HashSet<string> RemovableTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "span", "p", "div", "em", "i", "b", "strong", "u", "s", "strike",
        "a", "font", "center", "blockquote"
    };

    private static readonly HashSet<string> PreserveTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "br", "hr", "img", "input", "meta", "link", "area", "base",
        "col", "embed", "param", "source", "track", "wbr",
        "td", "th", "tr", "tbody", "thead", "tfoot", "table",
        "iframe", "video", "audio", "canvas", "svg", "object"
    };

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;
        var prev = html;
        var maxIterations = 10;

        for (var i = 0; i < maxIterations; i++)
        {
            html = EmptyTagRegex.Replace(html, m =>
            {
                var tagName = m.Groups[1].Value.ToLowerInvariant();
                if (PreserveTags.Contains(tagName))
                    return m.Value;
                if (!RemovableTags.Contains(tagName))
                    return m.Value;
                return string.Empty;
            });

            html = SelfClosingEmptyTagRegex.Replace(html, m =>
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

        html = MultipleSpacesRegex.Replace(html, " ");
        return html;
    }
}
