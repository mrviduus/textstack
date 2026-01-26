using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T002: Detects wrong dash types (hyphens used as em/en dashes).
/// </summary>
public partial class WrongDashRule : ILintRule
{
    public string Code => "T002";
    public string Description => "Wrong dash type found";

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Check for spaced hyphens that should be em dashes
        // Pattern: word - word (hyphen with spaces)
        var spacedHyphens = SpacedHyphenRegex().Matches(html);
        foreach (Match match in spacedHyphens)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Spaced hyphen found (should be em dash)",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }

        // Check for double hyphens that should be em dashes
        var doubleHyphens = DoubleHyphenRegex().Matches(html);
        foreach (Match match in doubleHyphens)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Double hyphen found (should be em dash)",
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
        var end = Math.Min(html.Length, index + 20);
        return html.Substring(start, end - start).Replace('\n', ' ').Replace('\r', ' ');
    }

    private static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }

    // Matches: word - word (spaced hyphen)
    [GeneratedRegex(@"\w\s+-\s+\w")]
    private static partial Regex SpacedHyphenRegex();

    // Matches: -- (double hyphen not already converted)
    [GeneratedRegex(@"--")]
    private static partial Regex DoubleHyphenRegex();
}
