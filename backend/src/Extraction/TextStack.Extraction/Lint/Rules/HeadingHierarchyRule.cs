using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// H002: Detects heading hierarchy issues (skipped levels).
/// </summary>
public partial class HeadingHierarchyRule : LintRuleBase
{
    public override string Code => "H002";
    public override string Description => "Heading hierarchy skipped (e.g., h1 to h3)";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var headingMatches = HeadingRegex().Matches(html);
        var lastLevel = 0;

        foreach (Match match in headingMatches)
        {
            var currentLevel = int.Parse(match.Groups[1].Value);

            // Check if we skipped a level (going down)
            if (lastLevel > 0 && currentLevel > lastLevel + 1)
            {
                yield return new LintIssue(
                    Code,
                    LintSeverity.Warning,
                    $"Heading hierarchy skipped: h{lastLevel} to h{currentLevel}",
                    chapterNumber,
                    GetLineNumber(html, match.Index),
                    GetContext(html, match.Index)
                );
            }

            lastLevel = currentLevel;
        }
    }

    // Match heading tags h1-h6
    [GeneratedRegex(@"<h([1-6])\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex HeadingRegex();
}
