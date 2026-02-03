using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// S002: Detects Roman numerals not marked up semantically.
/// </summary>
public partial class UnmarkedRomanNumeralRule : LintRuleBase
{
    public override string Code => "S002";
    public override string Description => "Roman numeral not marked with semantic element";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = RomanNumeralRegex().Matches(html);
        foreach (Match match in matches)
        {
            if (IsInsideHtmlTag(html, match.Index))
                continue;

            // Check if it's inside an abbr tag
            if (IsInsideAbbrTag(html, match.Index))
                continue;

            // Skip common false positives (I, V as words)
            var numeral = match.Value;
            if (numeral == "I" || numeral == "V")
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Info,
                $"Possible Roman numeral '{numeral}' not marked up",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    private static bool IsInsideAbbrTag(string html, int index)
    {
        // Look backwards for opening <abbr
        var lastAbbrOpen = html.LastIndexOf("<abbr", index, StringComparison.OrdinalIgnoreCase);
        if (lastAbbrOpen < 0)
            return false;

        // Check if we found closing </abbr> between the opening and current position
        var lastAbbrClose = html.LastIndexOf("</abbr>", index, StringComparison.OrdinalIgnoreCase);
        return lastAbbrOpen > lastAbbrClose;
    }

    // Roman numerals (II and above, excluding single I and V which are common words)
    [GeneratedRegex(@"\b((?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{1,3}))\b", RegexOptions.IgnoreCase)]
    private static partial Regex RomanNumeralRegex();
}
