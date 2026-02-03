using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// H003: Detects empty or whitespace-only paragraphs.
/// </summary>
public partial class EmptyParagraphRule : LintRuleBase
{
    public override string Code => "H003";
    public override string Description => "Empty or whitespace-only paragraph";

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = EmptyParagraphRegex().Matches(html);
        foreach (Match match in matches)
        {
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Empty paragraph element",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }

        // Also check for paragraphs with only whitespace or &nbsp;
        var whitespaceMatches = WhitespaceParagraphRegex().Matches(html);
        foreach (Match match in whitespaceMatches)
        {
            yield return new LintIssue(
                Code,
                LintSeverity.Warning,
                "Paragraph contains only whitespace",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index)
            );
        }
    }

    // Empty <p></p> or <p />
    [GeneratedRegex(@"<p\b[^>]*>\s*</p>|<p\b[^>]*/\s*>")]
    private static partial Regex EmptyParagraphRegex();

    // Paragraph with only whitespace, &nbsp;, or <br>
    [GeneratedRegex(@"<p\b[^>]*>(\s|&nbsp;|<br\s*/?>)+</p>", RegexOptions.IgnoreCase)]
    private static partial Regex WhitespaceParagraphRegex();
}
