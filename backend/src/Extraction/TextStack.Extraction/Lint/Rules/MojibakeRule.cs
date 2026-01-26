using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// M001: Detects mojibake (encoding errors) in text.
/// Common patterns from incorrectly decoded UTF-8 as Latin-1.
/// </summary>
public partial class MojibakeRule : ILintRule
{
    public string Code => "M001";
    public string Description => "Possible encoding error (mojibake) detected";

    // Common mojibake patterns from UTF-8 decoded as Latin-1/Windows-1252
    // Using escape sequences to avoid encoding issues in source
    private static readonly (string Pattern, string LikelyMeaning)[] MojibakePatterns =
    [
        ("\u00E2\u20AC\u2122", "apostrophe/right single quote"),
        ("\u00E2\u20AC\u0153", "left double quote"),
        ("\u00E2\u20AC\u009D", "right double quote"),
        ("\u00E2\u20AC\u201D", "em dash"),
        ("\u00E2\u20AC\u201C", "en dash"),
        ("\u00E2\u20AC\u00A6", "ellipsis"),
        ("\u00C3\u00A9", "e-acute"),
        ("\u00C3\u00A8", "e-grave"),
        ("\u00C3\u00A0", "a-grave"),
        ("\u00C3\u00A2", "a-circumflex"),
        ("\u00C3\u00AE", "i-circumflex"),
        ("\u00C3\u00B4", "o-circumflex"),
        ("\u00C3\u00BB", "u-circumflex"),
        ("\u00C3\u00A7", "c-cedilla"),
        ("\u00C3\u00B1", "n-tilde"),
        ("\u00C3\u00BC", "u-umlaut"),
        ("\u00C3\u00B6", "o-umlaut"),
        ("\u00C3\u00A4", "a-umlaut"),
        ("\u00C2\u00A3", "pound sign"),
        ("\u00C2\u00A9", "copyright"),
        ("\u00C2\u00AE", "registered"),
        ("\u00C2\u00B0", "degree"),
        ("\u00C2\u00BD", "one half"),
        ("\u00C2\u00BC", "one quarter"),
        ("\u00C2\u00BE", "three quarters"),
        ("\u00EF\u00BB\u00BF", "BOM (byte order mark)"),
        ("\u00C2\u00A0", "non-breaking space encoded wrong"),
    ];

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        foreach (var (pattern, meaning) in MojibakePatterns)
        {
            var index = 0;
            while ((index = html.IndexOf(pattern, index, StringComparison.Ordinal)) >= 0)
            {
                // Skip if inside HTML tag
                if (!IsInsideHtmlTag(html, index))
                {
                    var context = GetContext(html, index);
                    yield return new LintIssue(
                        Code,
                        LintSeverity.Error,
                        $"Possible mojibake detected (likely {meaning})",
                        chapterNumber,
                        GetLineNumber(html, index),
                        context
                    );
                }
                index += pattern.Length;
            }
        }

        // Also check for replacement character
        var replacementIndex = 0;
        while ((replacementIndex = html.IndexOf('\uFFFD', replacementIndex)) >= 0)
        {
            if (!IsInsideHtmlTag(html, replacementIndex))
            {
                var context = GetContext(html, replacementIndex);
                yield return new LintIssue(
                    Code,
                    LintSeverity.Error,
                    "Unicode replacement character (U+FFFD) found - indicates encoding error",
                    chapterNumber,
                    GetLineNumber(html, replacementIndex),
                    context
                );
            }
            replacementIndex++;
        }
    }

    private static bool IsInsideHtmlTag(string html, int index)
    {
        var lastOpenTag = html.LastIndexOf('<', index);
        var lastCloseTag = html.LastIndexOf('>', index);
        return lastOpenTag > lastCloseTag;
    }

    private static string GetContext(string html, int index)
    {
        var start = Math.Max(0, index - 20);
        var end = Math.Min(html.Length, index + 20);
        return html.Substring(start, end - start).Replace('\n', ' ').Replace('\r', ' ');
    }

    private static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }
}
