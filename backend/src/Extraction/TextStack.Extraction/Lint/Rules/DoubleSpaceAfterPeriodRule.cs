using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T007: Detects double spaces after periods (typewriter convention).
/// </summary>
public partial class DoubleSpaceAfterPeriodRule : LintRuleBase
{
    public override string Code => "T007";
    public override string Description => "Double space after period (typewriter style)";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = DoubleSpaceAfterPeriodRegex().Matches(html);
        foreach (Match match in matches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Double space after sentence-ending punctuation",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    // Double space after period, question mark, or exclamation
    [GeneratedRegex(@"[.!?]\s{2,}(?=\p{Lu})")]
    private static partial Regex DoubleSpaceAfterPeriodRegex();
}
