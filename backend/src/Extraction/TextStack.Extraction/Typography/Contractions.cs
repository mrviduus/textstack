using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Handles archaic contractions and possessives.
/// Ported from Standard Ebooks typography.py.
/// </summary>
public static partial class Contractions
{
    /// <summary>
    /// Fix archaic contractions: 'tis, 'twas, 'twere, 'em, etc.
    /// Also fixes wrong quote types (left single quote instead of apostrophe).
    /// </summary>
    public static string FixArchaicContractions(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Fix missing apostrophe before common contractions (after whitespace or tag)
        // 'tis → 'tis, twas → 'twas
        html = MissingApostropheRegex().Replace(html, "$1\u2019$2");

        // Fix wrong quote type: "tis → 'tis (left double → apostrophe)
        html = WrongDoubleQuoteRegex().Replace(html, "\u2019$1");

        // Fix wrong quote type: 'tis → 'tis (left single → apostrophe)
        html = WrongSingleQuoteRegex().Replace(html, "\u2019$1");

        // Common archaic contractions needing apostrophe
        html = CommonArchaicRegex().Replace(html, "\u2019$1");

        // 'a' abbreviation: surrounded by spaces
        html = AbbrevARegex().Replace(html, "$1\u2019a\u2019$2");

        // Year abbreviations: '20s, '90s
        html = YearAbbrevRegex().Replace(html, "\u2019$1");

        // o'clock
        html = OClockRegex().Replace(html, "o\u2019clock");

        // fo'c'sle (forecastle)
        html = FocSleRegex().Replace(html, "fo\u2019c\u2019sle");

        // bo's'n (boatswain)
        html = BosnRegex().Replace(html, "bo\u2019s\u2019n");

        return html;
    }

    /// <summary>
    /// Fix possessives after inline HTML elements: </i>'s → </i>'s
    /// </summary>
    public static string FixPossessivesAfterTags(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Possessive 's or 'd after closing inline tags
        html = PossessiveAfterTagRegex().Replace(html, "</$1>\u2019$2");

        // Possessive after abbr: </abbr>'s
        html = PossessiveAfterAbbrRegex().Replace(html, "</abbr>\u2019$1");

        return html;
    }

    // Missing apostrophe: space/tag + contraction word
    [GeneratedRegex(@"([\s>])([Tt]is|[Tt]was|[Tt]were|[Tt]won't|[Tt]would|[Tt]wouldn't|[Tt]will|[Tt]wixt|[Tt]ween)\b")]
    private static partial Regex MissingApostropheRegex();

    // Wrong double quote before contraction
    [GeneratedRegex(@"[\u201C\u201D]([Tt]is|[Tt]was|[Tt]were|[Tt]won't|[Tt]would|[Tt]will)\b")]
    private static partial Regex WrongDoubleQuoteRegex();

    // Wrong single quote (left) before contraction
    [GeneratedRegex(@"\u2018([Tt]is|[Tt]was|[Tt]were|[Tt]won't|[Tt]would|[Tt]will|[Ee]m|[Gg]ainst|[Nn]eath)\b")]
    private static partial Regex WrongSingleQuoteRegex();

    // Common archaic contractions with wrong/missing apostrophe
    [GeneratedRegex(@"'([Aa]ve|[Oo]me|[Ii]m|[Mm]idst|[Gg]ainst|[Nn]eath|[Ee]m|[Cc]os|[Tt]is|[Tt]was|[Tt]wixt|[Tt]were|[Tt]would|[Tt]ween|[Tt]will|[Rr]ound|[Pp]on|[Uu]ns?|[Cc]ept|[Oo]w|[Aa]ppen|[Ee]re|[Aa]lf)\b")]
    private static partial Regex CommonArchaicRegex();

    // 'a' abbreviation surrounded by spaces
    [GeneratedRegex(@"(\s)'a'(\s)", RegexOptions.IgnoreCase)]
    private static partial Regex AbbrevARegex();

    // Year abbreviations: '20s, '90s
    [GeneratedRegex(@"'(\d{2,}[^\p{L}0-9'])")]
    private static partial Regex YearAbbrevRegex();

    // o'clock
    [GeneratedRegex(@"o['\u2018\u2019]clock", RegexOptions.IgnoreCase)]
    private static partial Regex OClockRegex();

    // fo'c'sle (forecastle nautical term)
    [GeneratedRegex(@"fo['\u2018\u2019]?c['\u2018\u2019]?s['\u2018\u2019]?le", RegexOptions.IgnoreCase)]
    private static partial Regex FocSleRegex();

    // bo's'n (boatswain)
    [GeneratedRegex(@"bo['\u2018\u2019]?s['\u2018\u2019]?n\b", RegexOptions.IgnoreCase)]
    private static partial Regex BosnRegex();

    // Possessive after inline tags: </i>'s, </em>'d
    [GeneratedRegex(@"</(i|em|b|strong|q|span)>['\u2018]([sd])\b")]
    private static partial Regex PossessiveAfterTagRegex();

    // Possessive after abbr
    [GeneratedRegex(@"</abbr>['\u2018]([sd])\b")]
    private static partial Regex PossessiveAfterAbbrRegex();
}
