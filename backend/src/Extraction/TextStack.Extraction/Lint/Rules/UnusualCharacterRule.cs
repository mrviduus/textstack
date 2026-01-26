namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// U001: Detects unusual Unicode characters that may indicate issues.
/// </summary>
public class UnusualCharacterRule : ILintRule
{
    public string Code => "U001";
    public string Description => "Unusual Unicode character detected";

    // Characters that are unusual in typical English text
    private static readonly (char Char, string Name, string Suggestion)[] UnusualChars =
    [
        // Control characters (shouldn't appear in text)
        ('\u0000', "NULL", "Remove"),
        ('\u0001', "SOH", "Remove"),
        ('\u0002', "STX", "Remove"),
        ('\u0003', "ETX", "Remove"),
        ('\u0004', "EOT", "Remove"),
        ('\u0005', "ENQ", "Remove"),
        ('\u0006', "ACK", "Remove"),
        ('\u0007', "BEL", "Remove"),
        ('\u0008', "BS", "Remove"),
        ('\u000B', "VT", "Remove"),
        ('\u000C', "FF", "Remove"),
        ('\u000E', "SO", "Remove"),
        ('\u000F', "SI", "Remove"),

        // Soft hyphen (often invisible, causes issues)
        ('\u00AD', "SOFT HYPHEN", "Remove or replace with regular hyphen if needed"),

        // Zero-width characters (usually unwanted)
        ('\u200B', "ZERO WIDTH SPACE", "Usually remove"),
        ('\u200C', "ZERO WIDTH NON-JOINER", "Usually remove unless needed for language"),
        ('\u200D', "ZERO WIDTH JOINER", "Usually remove unless needed for language"),
        ('\uFEFF', "BOM/ZERO WIDTH NO-BREAK SPACE", "Remove (usually from file start)"),

        // Unusual spaces
        ('\u2000', "EN QUAD", "Consider regular space"),
        ('\u2001', "EM QUAD", "Consider regular space"),
        ('\u2002', "EN SPACE", "Consider regular space"),
        ('\u2003', "EM SPACE", "Consider regular space"),
        ('\u2004', "THREE-PER-EM SPACE", "Consider regular space"),
        ('\u2005', "FOUR-PER-EM SPACE", "Consider regular space"),
        ('\u2006', "SIX-PER-EM SPACE", "Consider regular space"),
        ('\u2007', "FIGURE SPACE", "Consider regular space"),
        ('\u2008', "PUNCTUATION SPACE", "Consider regular space"),
        ('\u2009', "THIN SPACE", "Consider regular space or hair space"),
        ('\u200A', "HAIR SPACE", "OK for typography, verify intentional"),
        ('\u202F', "NARROW NO-BREAK SPACE", "Consider regular nbsp"),
        ('\u205F', "MEDIUM MATHEMATICAL SPACE", "Consider regular space"),

        // Private use area (undefined meaning)
        ('\uE000', "PRIVATE USE AREA START", "Remove or replace"),

        // Specials
        ('\uFFFC', "OBJECT REPLACEMENT CHARACTER", "Remove"),
        ('\uFFFD', "REPLACEMENT CHARACTER", "Encoding error - needs fix"),

        // Unusual quotes (beyond standard curly quotes)
        ('\u201A', "SINGLE LOW-9 QUOTATION MARK", "Consider standard quotes"),
        ('\u201E', "DOUBLE LOW-9 QUOTATION MARK", "Consider standard quotes"),
        ('\u2039', "SINGLE LEFT-POINTING ANGLE QUOTATION", "Consider standard quotes"),
        ('\u203A', "SINGLE RIGHT-POINTING ANGLE QUOTATION", "Consider standard quotes"),

        // Mathematical operators that might be OCR errors
        ('\u00D7', "MULTIPLICATION SIGN", "May be intended as 'x'"),
        ('\u00F7', "DIVISION SIGN", "Verify intentional"),
    ];

    public IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        foreach (var (unusualChar, name, suggestion) in UnusualChars)
        {
            var index = 0;
            while ((index = html.IndexOf(unusualChar, index)) >= 0)
            {
                // Skip if inside HTML tag attribute
                if (!IsInsideHtmlTag(html, index))
                {
                    var context = GetContext(html, index);
                    var severity = IsControlCharacter(unusualChar) || unusualChar == '\uFFFD'
                        ? LintSeverity.Error
                        : LintSeverity.Warning;

                    yield return new LintIssue(
                        Code,
                        severity,
                        $"Unusual character U+{(int)unusualChar:X4} ({name}). {suggestion}",
                        chapterNumber,
                        GetLineNumber(html, index),
                        context
                    );
                }
                index++;
            }
        }

        // Check for characters in BMP Private Use Area
        for (var i = 0; i < html.Length; i++)
        {
            var c = html[i];
            if (c >= '\uE000' && c <= '\uF8FF')
            {
                if (!IsInsideHtmlTag(html, i))
                {
                    var context = GetContext(html, i);
                    yield return new LintIssue(
                        Code,
                        LintSeverity.Warning,
                        $"Private Use Area character U+{(int)c:X4}. May need replacement.",
                        chapterNumber,
                        GetLineNumber(html, i),
                        context
                    );
                }
            }
        }
    }

    private static bool IsControlCharacter(char c)
    {
        return c < '\u0020' && c != '\t' && c != '\n' && c != '\r';
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
        var context = html.Substring(start, end - start);
        // Replace the unusual char with a visible marker for context
        return context.Replace('\n', ' ').Replace('\r', ' ');
    }

    private static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }
}
