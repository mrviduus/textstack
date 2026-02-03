using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// T005: Detects inconsistent quote usage (mixing styles).
/// </summary>
public partial class InconsistentQuotesRule : LintRuleBase
{
    public override string Code => "T005";
    public override string Description => "Inconsistent quote style detected";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        // Count curly vs straight quotes
        var curlyDoubleCount = CurlyDoubleQuoteRegex().Matches(html).Count;
        var straightDoubleCount = StraightDoubleQuoteRegex().Matches(html).Count;
        var curlySingleCount = CurlySingleQuoteRegex().Matches(html).Count;
        var straightSingleCount = StraightSingleQuoteRegex().Matches(html).Count;

        // If both styles are present, report inconsistency
        if (curlyDoubleCount > 0 && straightDoubleCount > 0)
        {
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                $"Mixed double quote styles: {curlyDoubleCount} curly, {straightDoubleCount} straight",
                chapterNumber,
                null,
                null
            );
        }

        if (curlySingleCount > 0 && straightSingleCount > 0)
        {
            // Check for potential apostrophe issues (straight in words)
            var apostropheMatches = StraightApostropheInWordRegex().Matches(html);
            if (apostropheMatches.Count > 0)
            {
                yield return new LintIssue(
                    Code,
                    LintSeverity.Warning,
                    $"Mixed single quote/apostrophe styles: {curlySingleCount} curly, {straightSingleCount} straight",
                    chapterNumber,
                    null,
                    null
                );
            }
        }

        // Check for mismatched opening/closing curly quotes
        var leftDouble = LeftDoubleQuoteRegex().Matches(html).Count;
        var rightDouble = RightDoubleQuoteRegex().Matches(html).Count;

        if (Math.Abs(leftDouble - rightDouble) > 2) // Allow small tolerance
        {
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                $"Mismatched curly double quotes: {leftDouble} opening, {rightDouble} closing",
                chapterNumber,
                null,
                null
            );
        }
    }

    [GeneratedRegex(@"[\u201C\u201D]")]
    private static partial Regex CurlyDoubleQuoteRegex();

    [GeneratedRegex(@"""(?![^<]*>)")]
    private static partial Regex StraightDoubleQuoteRegex();

    [GeneratedRegex(@"[\u2018\u2019]")]
    private static partial Regex CurlySingleQuoteRegex();

    [GeneratedRegex(@"'(?![^<]*>)")]
    private static partial Regex StraightSingleQuoteRegex();

    [GeneratedRegex(@"\p{L}'\p{L}")]
    private static partial Regex StraightApostropheInWordRegex();

    [GeneratedRegex(@"\u201C")]
    private static partial Regex LeftDoubleQuoteRegex();

    [GeneratedRegex(@"\u201D")]
    private static partial Regex RightDoubleQuoteRegex();
}
