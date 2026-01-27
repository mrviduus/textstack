using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T003: Detects multiple consecutive spaces.
/// </summary>
public partial class MultipleSpacesRule : LintRuleBase
{
    public override string Code => "T003";
    public override string Description => "Multiple consecutive spaces found";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = MultipleSpacesRegex().Matches(html);
        foreach (Match match in matches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Info,
                $"Found {match.Length} consecutive spaces",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index, 40)
            );
        }
    }

    [GeneratedRegex(@"[ ]{2,}")]
    private static partial Regex MultipleSpacesRegex();
}
