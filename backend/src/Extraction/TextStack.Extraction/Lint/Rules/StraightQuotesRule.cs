using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T001: Detects straight quotes that should be curly quotes.
/// </summary>
public partial class StraightQuotesRule : ILintRule
{
    public string Code => "T001";
    public string Description => "Straight quotes found (should be curly)";

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Check for straight double quotes (but not in HTML attributes)
        var matches = StraightDoubleQuoteRegex().Matches(html);
        foreach (Match match in matches)
        {
            // Skip if inside an HTML tag
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            var context = GetContext(html, match.Index);
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Straight double quote found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                context
            );
        }

        // Check for straight single quotes that look like apostrophes
        // Be careful: ' can be legitimate in HTML entities like &apos;
        var singleMatches = StraightSingleQuoteRegex().Matches(html);
        foreach (Match match in singleMatches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            // Skip if part of HTML entity
            if (IsPartOfEntity(html, match.Index))
                continue;

            var context = GetContext(html, match.Index);
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Straight single quote/apostrophe found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                context
            );
        }
    }

    private static bool IsInsideHtmlTag(string html, int index)
    {
        var lastOpenTag = html.LastIndexOf('<', index);
        var lastCloseTag = html.LastIndexOf('>', index);
        return lastOpenTag > lastCloseTag;
    }

    private static bool IsPartOfEntity(string html, int index)
    {
        // Check if this is &apos; or similar
        if (index >= 5 && html.Substring(index - 5, 6) == "&apos;")
            return true;
        if (index >= 1 && index + 4 <= html.Length && html.Substring(index - 1, 6) == "&apos;")
            return true;
        return false;
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

    [GeneratedRegex("\"(?![^<]*>)")]
    private static partial Regex StraightDoubleQuoteRegex();

    [GeneratedRegex("'(?![^<]*>)")]
    private static partial Regex StraightSingleQuoteRegex();
}
