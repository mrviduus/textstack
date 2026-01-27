using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// X001: Detects empty HTML tags.
/// </summary>
public partial class EmptyTagRule : LintRuleBase
{
    public override string Code => "X001";
    public override string Description => "Empty HTML tag found";

    private static readonly HashSet<string> AllowedEmptyTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "br", "hr", "img", "input", "meta", "link", "area", "base",
        "col", "embed", "param", "source", "track", "wbr",
        "td", "th", "iframe", "video", "audio", "canvas", "svg", "object"
    };

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        var matches = EmptyTagRegex().Matches(html);
        foreach (Match match in matches)
        {
            var tagName = match.Groups[1].Value.ToLowerInvariant();

            if (AllowedEmptyTags.Contains(tagName))
                continue;

            yield return new LintIssue(
                Code,
                LintSeverity.Info,
                $"Empty <{tagName}> tag found",
                chapterNumber,
                GetLineNumber(html, match.Index),
                GetContext(html, match.Index, 40)
            );
        }
    }

    [GeneratedRegex(@"<(\w+)(?:\s+[^>]*)?>\s*</\1>", RegexOptions.IgnoreCase)]
    private static partial Regex EmptyTagRegex();
}
