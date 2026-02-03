using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// C003: Detects repeated words (e.g., "the the").
/// </summary>
public partial class DoubleWordRule : LintRuleBase
{
    public override string Code => "C003";
    public override string Description => "Repeated word detected";

    // Words that are legitimately repeated
    private static readonly HashSet<string> AllowedRepeats = new(StringComparer.OrdinalIgnoreCase)
    {
        "had", "that", "very", "so", "out", "far", "much", "well",
        "blah", "ha", "he", "ho", "la", "no", "oh", "on", "so", "um", "uh"
    };

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = DoubleWordRegex().Matches(html);
        foreach (Match match in matches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            var word = match.Groups[1].Value;

            // Skip allowed repeated words
            if (AllowedRepeats.Contains(word))
                continue;

            // Skip if between tags (could be intentional, e.g., </p><p>)
            if (IsAcrossTagBoundary(html, match))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Error,
                $"Repeated word: \"{word} {word}\"",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    private static bool IsAcrossTagBoundary(string html, Match match)
    {
        // Check if there's a tag between the two words
        var betweenText = html.Substring(match.Index, match.Length);
        return betweenText.Contains('<') || betweenText.Contains('>');
    }

    // Match repeated words separated by whitespace
    [GeneratedRegex(@"\b(\p{L}+)\s+\1\b", RegexOptions.IgnoreCase)]
    private static partial Regex DoubleWordRegex();
}
