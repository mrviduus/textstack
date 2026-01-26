using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// X001: Detects empty HTML tags.
/// </summary>
public partial class EmptyTagRule : ILintRule
{
    public string Code => "X001";
    public string Description => "Empty HTML tag found";

    // Tags that are allowed to be empty
    private static readonly HashSet<string> AllowedEmptyTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "br", "hr", "img", "input", "meta", "link", "area", "base",
        "col", "embed", "param", "source", "track", "wbr",
        "td", "th", "iframe", "video", "audio", "canvas", "svg", "object"
    };

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = EmptyTagRegex().Matches(html);
        foreach (Match match in matches)
        {
            var tagName = match.Groups[1].Value.ToLowerInvariant();

            // Skip allowed empty tags
            if (AllowedEmptyTags.Contains(tagName))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Info,
                $"Empty <{tagName}> tag found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    private static string GetContext(string html, int index)
    {
        var start = Math.Max(0, index - 10);
        var end = Math.Min(html.Length, index + 50);
        return html.Substring(start, end - start).Replace('\n', ' ').Replace('\r', ' ');
    }

    private static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }

    // Matches: <tag>whitespace-only</tag> or <tag></tag>
    [GeneratedRegex(@"<(\w+)(?:\s+[^>]*)?>\s*</\1>", RegexOptions.IgnoreCase)]
    private static partial Regex EmptyTagRegex();
}
