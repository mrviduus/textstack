using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T004: Detects missing word joiners before/after certain punctuation.
/// </summary>
public partial class MissingWordJoinerRule : LintRuleBase
{
    public override string Code => "T004";
    public override string Description => "Missing word joiner before ellipsis or em-dash";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Check for ellipsis without word joiner
        var ellipsisMatches = EllipsisWithoutJoinerRegex().Matches(html);
        foreach (Match match in ellipsisMatches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Ellipsis without word joiner",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }

        // Check for em-dash at start of line without word joiner
        var dashMatches = EmDashStartRegex().Matches(html);
        foreach (Match match in dashMatches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Em-dash at line start without word joiner",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    // Ellipsis without preceding word joiner (when after a word)
    [GeneratedRegex(@"\p{L}(?!\u2060)\s*\u2026")]
    private static partial Regex EllipsisWithoutJoinerRegex();

    // Em-dash at start of paragraph/line without word joiner
    [GeneratedRegex(@"(?<=>)\s*(?!\u2060)\u2014")]
    private static partial Regex EmDashStartRegex();
}
