using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T002: Detects wrong dash types (hyphens used as em/en dashes).
/// </summary>
public partial class WrongDashRule : LintRuleBase
{
    public override string Code => "T002";
    public override string Description => "Wrong dash type found";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Check for spaced hyphens that should be em dashes
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

    [GeneratedRegex(@"\w\s+-\s+\w")]
    private static partial Regex SpacedHyphenRegex();

    [GeneratedRegex(@"--")]
    private static partial Regex DoubleHyphenRegex();
}
