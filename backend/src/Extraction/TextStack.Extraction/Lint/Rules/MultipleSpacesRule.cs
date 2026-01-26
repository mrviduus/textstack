using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T003: Detects multiple consecutive spaces.
/// </summary>
public partial class MultipleSpacesRule : ILintRule
{
    public string Code => "T003";
    public string Description => "Multiple consecutive spaces found";

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = MultipleSpacesRegex().Matches(html);
        foreach (Match match in matches)
        {
            // Skip if inside HTML tag attributes
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Info,
                $"Found {match.Length} consecutive spaces",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    private static bool IsInsideHtmlTag(string html, int index)
    {
        var lastOpenTag = html.LastIndexOf('<', index);
        var lastCloseTag = html.LastIndexOf('>', index);
        return lastOpenTag > lastCloseTag;
    }

    private static string GetContext(string html, int index)
    {
        var start = Math.Max(0, index - 20);
        var end = Math.Min(html.Length, index + 40);
        return html.Substring(start, end - start).Replace('\n', ' ').Replace('\r', ' ');
    }

    private static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }

    // Matches: 2 or more consecutive regular spaces
    [GeneratedRegex(@"[ ]{2,}")]
    private static partial Regex MultipleSpacesRegex();
}
