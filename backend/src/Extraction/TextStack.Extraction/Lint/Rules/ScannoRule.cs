using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// C002: Detects common OCR errors (scannos).
/// </summary>
public partial class ScannoRule : LintRuleBase
{
    public override string Code => "C002";
    public override string Description => "Possible OCR error (scanno)";

    // Common OCR error patterns
    private static readonly (Regex Pattern, string Message)[] Scannos =
    [
        (new Regex(@"\brn\b", RegexOptions.Compiled), "Possible 'm' misread as 'rn'"),
        (new Regex(@"\bcl\b", RegexOptions.Compiled), "Possible 'd' misread as 'cl'"),
        (new Regex(@"\bli\b", RegexOptions.Compiled), "Possible 'h' misread as 'li'"),
        (new Regex(@"\b[tl]he\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'the' with l/t confusion"),
        (new Regex(@"\bof\s+of\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Repeated 'of of'"),
        (new Regex(@"\bthe\s+the\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Repeated 'the the'"),
        (new Regex(@"\ba\s+a\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Repeated 'a a'"),
        (new Regex(@"\band\s+and\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Repeated 'and and'"),
        (new Regex(@"\bto\s+to\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Repeated 'to to'"),
        (new Regex(@"\btbe\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'the' misread as 'tbe'"),
        (new Regex(@"\bwbo\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'who' misread as 'wbo'"),
        (new Regex(@"\bwbich\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'which' misread as 'wbich'"),
        (new Regex(@"\bvvas\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'was' misread as 'vvas'"),
        (new Regex(@"\bliave\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible 'have' misread as 'liave'"),
        (new Regex(@"\bfrom\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Check 'from' - common OCR target"),
        (new Regex(@"\b[il]t\b", RegexOptions.Compiled), "Possible 'it' with i/l confusion"),
        (new Regex(@"\bcould\s+n[o0]t\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible spacing issue in 'couldn't'"),
        (new Regex(@"\bwould\s+n[o0]t\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible spacing issue in 'wouldn't'"),
        (new Regex(@"\bshould\s+n[o0]t\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Possible spacing issue in 'shouldn't'"),
        (new Regex(@"\b0f\b", RegexOptions.Compiled), "Possible 'of' with 0/o confusion"),
        (new Regex(@"\bt0\b", RegexOptions.Compiled), "Possible 'to' with 0/o confusion"),
        (new Regex(@"\bn0t\b", RegexOptions.Compiled), "Possible 'not' with 0/o confusion"),
        (new Regex(@"\b1t\b", RegexOptions.Compiled), "Possible 'it' with 1/i confusion"),
        (new Regex(@"\b1n\b", RegexOptions.Compiled), "Possible 'in' with 1/i confusion"),
        (new Regex(@"\b1s\b", RegexOptions.Compiled), "Possible 'is' with 1/i confusion"),
    ];

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        foreach (var (pattern, message) in Scannos)
        {
            var matches = pattern.Matches(html);
            foreach (Match match in matches)
            {
                if (IsInsideHtmlTag(html, match.Index))
                    continue;

                yield return new LintIssue(
                    Code,
                    LintSeverity.Warning,
                    message,
                    chapterNumber,
                    GetLineNumber(html, match.Index),
                    GetContext(html, match.Index)
                );
            }
        }
    }
}
