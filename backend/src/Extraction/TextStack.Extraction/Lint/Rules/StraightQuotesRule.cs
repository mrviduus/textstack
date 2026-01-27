using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T001: Detects straight quotes that should be curly quotes.
/// </summary>
public partial class StraightQuotesRule : LintRuleBase
{
    public override string Code => "T001";
    public override string Description => "Straight quotes found (should be curly)";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Check for straight double quotes (but not in HTML attributes)
        var matches = StraightDoubleQuoteRegex().Matches(html);
        foreach (Match match in matches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Straight double quote found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }

        // Check for straight single quotes that look like apostrophes
        var singleMatches = StraightSingleQuoteRegex().Matches(html);
        foreach (Match match in singleMatches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            if (IsPartOfEntity(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Straight single quote/apostrophe found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    private static bool IsPartOfEntity(string html, int index)
    {
        if (index >= 5 && html.Substring(index - 5, 6) == "&apos;")
            return true;
        if (index >= 1 && index + 4 <= html.Length && html.Substring(index - 1, 6) == "&apos;")
            return true;
        return false;
    }

    [GeneratedRegex("\"(?![^<]*>)")]
    private static partial Regex StraightDoubleQuoteRegex();

    [GeneratedRegex("'(?![^<]*>)")]
    private static partial Regex StraightSingleQuoteRegex();
}
