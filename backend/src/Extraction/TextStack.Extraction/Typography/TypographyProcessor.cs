using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Typography processor ported from Standard Ebooks typography.py.
/// Applies typographic enhancements: smart quotes, proper dashes, ellipses, fractions, etc.
/// </summary>
public static partial class TypographyProcessor
{
    // Unicode constants
    public const char Nbsp = '\u00a0';           // Non-breaking space
    public const char WordJoiner = '\u2060';     // Word joiner (prevents line break)
    public const char HairSpace = '\u200a';      // Hair space
    public const char EmDash = '\u2014';         // em dash
    public const char EnDash = '\u2013';         // en dash
    public const char Ellipsis = '\u2026';       // ellipsis
    public const char TwoEmDash = '\u2E3A';      // two-em dash
    public const char ThreeEmDash = '\u2E3B';    // three-em dash
    public const char HorizontalBar = '\u2015';  // horizontal bar
    public const char MinusSign = '\u2212';      // minus sign

    // Curly quotes
    public const char LeftDoubleQuote = '\u201C';   // left double
    public const char RightDoubleQuote = '\u201D';  // right double
    public const char LeftSingleQuote = '\u2018';   // left single
    public const char RightSingleQuote = '\u2019';  // right single


    /// <summary>
    /// Apply SE-style typographic enhancements to HTML content.
    /// </summary>
    public static string Typogrify(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // 1. Replace backtick with apostrophe (Gutenberg style)
        html = html.Replace("`", "'");

        // 2. Smart quotes: straight to curly
        html = ApplySmartQuotes(html);

        // 3. Dash processing (horizontal bar, multi-em, word joiners)
        html = Dashes.ProcessDashes(html);

        // 4. Replace space + en dash with word joiner + em dash
        html = SpaceEnDashRegex().Replace(html, WordJoiner.ToString() + EmDash);

        // 5. Fix common em-dash transcription errors
        html = ColonDashLetterRegex().Replace(html, "$1\u2014$2");
        html = LetterDashQuoteRegex().Replace(html, "$1\u2014\u201D");

        // 6. Add en dashes to number ranges (but not inside HTML tags)
        html = NumberRangeRegex().Replace(html, "$1\u2013$2");

        // 7. Handle title abbreviations with non-breaking space
        html = TitleAbbreviationsRegex().Replace(html, "$1.$2\u00a0");

        // 8. Handle No. with non-breaking space before number
        html = NumberAbbrevRegex().Replace(html, "No$1.\u00a0$2");

        // 9. Handle c/o
        html = CareOfRegex().Replace(html, "\u2105");

        // 10. Fix archaic contractions ('tis, 'twas, etc.)
        html = Contractions.FixArchaicContractions(html);

        // 11. Fix possessives after inline elements (</i>'s)
        html = Contractions.FixPossessivesAfterTags(html);

        // 12. House style: remove spacing from i.e. and e.g.
        html = IeSpacingRegex().Replace(html, "$1.e.");
        html = EgSpacingRegex().Replace(html, "$1.g.");

        // 13. Handle AD/BC era abbreviations (remove periods)
        html = AdSpacingRegex().Replace(html, "$1AD");
        html = BcSpacingRegex().Replace(html, "BC");

        // 14. Hair space between adjacent quotes
        html = AdjacentQuotesRegex1().Replace(html, "\u201D\u200a\u2019");
        html = AdjacentQuotesRegex2().Replace(html, "\u2019\u200a\u201D");
        html = AdjacentQuotesRegex3().Replace(html, "\u201C\u200a\u2018");
        html = AdjacentQuotesRegex4().Replace(html, "\u2018\u200a\u201C");

        // 15. Fix ellipses
        html = ThreeDotsRegex().Replace(html, Ellipsis.ToString());
        html = EllipsisPeriodRegex().Replace(html, ".\u200a\u2026");
        html = EllipsisSpacingRegex().Replace(html, "\u200a\u2026 ");
        html = EllipsisPunctuationRegex().Replace(html, "\u2026\u200a$1");

        // 16. Add word joiner before ellipses with hair space
        html = html.Replace("\u200a\u2026", "\u2060\u200a\u2060\u2026");

        // 17. Non-breaking space between number and abbreviated unit
        html = NumberUnitRegex().Replace(html, "$1\u00a0$2");

        // 18. Non-breaking space between number and AM/PM
        html = TimeAmPmRegex().Replace(html, "$1\u00a0$2.m.");

        // 19. Extended fractions
        html = Typography.Fractions.ConvertFractions(html);

        // 20. Unicode minus for negative numbers
        html = NegativeNumberRegex().Replace(html, "$1\u2212$2");

        // 21. Historical currency normalization (L → £)
        html = Currency.NormalizeCurrency(html);

        // 22. Fix O.K. to OK
        html = html.Replace("O.K.", "OK");

        // 23. Non-breaking space before &amp;
        html = html.Replace(" &amp;", "\u00a0&amp;");

        // 24. Remove word joiners from img alt attributes
        html = AltAttributeRegex().Replace(html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        // 25. Remove word joiners from title elements
        html = TitleElementRegex().Replace(html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        return html;
    }

    /// <summary>
    /// Apply smart quotes transformation (straight to curly).
    /// </summary>
    private static string ApplySmartQuotes(string html)
    {
        // Opening double quotes (after whitespace, tag, or start)
        html = OpeningDoubleQuoteRegex().Replace(html, "$1\u201C");

        // Closing double quotes (before punctuation, whitespace, tag, or end)
        html = ClosingDoubleQuoteRegex().Replace(html, "\u201D$1");

        // Remaining double quotes to closing (safer default)
        html = html.Replace("\"", "\u201D");

        // Opening single quotes (after whitespace, tag, or start, followed by letter)
        html = OpeningSingleQuoteRegex().Replace(html, "$1\u2018$2");

        // Apostrophes in contractions (letter'letter)
        html = ApostropheRegex().Replace(html, "$1\u2019$2");

        // Remaining single quotes after letters to apostrophe/closing
        html = RemainingSingleQuoteRegex().Replace(html, "$1\u2019");

        // Remaining single quotes before letters to opening
        html = SingleQuoteBeforeLetterRegex().Replace(html, "\u2018$1");

        return html;
    }

    // Smart quotes regexes
    [GeneratedRegex(@"(^|[\s>(\[{])""")]
    private static partial Regex OpeningDoubleQuoteRegex();

    [GeneratedRegex(@"""([\s<)\]}.,:;!?]|$)")]
    private static partial Regex ClosingDoubleQuoteRegex();

    [GeneratedRegex(@"(^|[\s>(\[{])'(\p{L})")]
    private static partial Regex OpeningSingleQuoteRegex();

    [GeneratedRegex(@"(\p{L})'(\p{L})")]
    private static partial Regex ApostropheRegex();

    [GeneratedRegex(@"(\p{L})'")]
    private static partial Regex RemainingSingleQuoteRegex();

    [GeneratedRegex(@"'(\p{L})")]
    private static partial Regex SingleQuoteBeforeLetterRegex();

    // Typography regexes
    [GeneratedRegex(@"\s\u2013\s?")]
    private static partial Regex SpaceEnDashRegex();

    [GeneratedRegex(@"([:;])-(\p{L})")]
    private static partial Regex ColonDashLetterRegex();

    [GeneratedRegex(@"(\p{L})-\u201D")]
    private static partial Regex LetterDashQuoteRegex();

    [GeneratedRegex(@"(?<!<[^>]*)(\d+)-(\d+)")]
    private static partial Regex NumberRangeRegex();

    [GeneratedRegex(@"\b(Mr|Mrs?|Drs?|Profs?|Lieut|Fr|Lt|Capt|Pvt|Esq|Mt|St|MM|Mmes?|Mlles?|Hon|Mdlle)\.?(</abbr>)?\s+")]
    private static partial Regex TitleAbbreviationsRegex();

    [GeneratedRegex(@"\bNo(s?)\.\s+(\d+)")]
    private static partial Regex NumberAbbrevRegex();

    [GeneratedRegex(@"c/o", RegexOptions.IgnoreCase)]
    private static partial Regex CareOfRegex();

    [GeneratedRegex(@"([Ii])\.\s+e\.")]
    private static partial Regex IeSpacingRegex();

    [GeneratedRegex(@"([Ee])\.\s+g\.")]
    private static partial Regex EgSpacingRegex();

    [GeneratedRegex(@"([\d\s])A\.\s*D\.")]
    private static partial Regex AdSpacingRegex();

    [GeneratedRegex(@"B\.\s*C\.")]
    private static partial Regex BcSpacingRegex();

    [GeneratedRegex(@"\u201D[\s\u00a0]*\u2019")]
    private static partial Regex AdjacentQuotesRegex1();

    [GeneratedRegex(@"\u2019[\s\u00a0]*\u201D")]
    private static partial Regex AdjacentQuotesRegex2();

    [GeneratedRegex(@"\u201C[\s\u00a0]*\u2018")]
    private static partial Regex AdjacentQuotesRegex3();

    [GeneratedRegex(@"\u2018[\s\u00a0]*\u201C")]
    private static partial Regex AdjacentQuotesRegex4();

    [GeneratedRegex(@"\s*\.\s*\.\s*\.\s*")]
    private static partial Regex ThreeDotsRegex();

    [GeneratedRegex(@"[\s\u00a0]?\u2026[\s\u00a0]?\.")]
    private static partial Regex EllipsisPeriodRegex();

    [GeneratedRegex(@"[\s\u00a0]?\u2026[\s\u00a0]?")]
    private static partial Regex EllipsisSpacingRegex();

    [GeneratedRegex(@"\u2026[\s\u00a0]?([!?.,;])")]
    private static partial Regex EllipsisPunctuationRegex();

    [GeneratedRegex(@"(\d)\s+(oz\.|lbs?\.)", RegexOptions.IgnoreCase)]
    private static partial Regex NumberUnitRegex();

    [GeneratedRegex(@"(\d)\s+([ap])\.m\.", RegexOptions.IgnoreCase)]
    private static partial Regex TimeAmPmRegex();

    [GeneratedRegex(@"([\s>])-(\d)")]
    private static partial Regex NegativeNumberRegex();

    [GeneratedRegex(@"alt=""[^""]*?[\u00a0\u2060][^""]*?""")]
    private static partial Regex AltAttributeRegex();

    [GeneratedRegex(@"<title>[^<]*?[\u00a0\u2060][^<]*?</title>")]
    private static partial Regex TitleElementRegex();
}
