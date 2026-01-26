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

    // Common fractions
    private static readonly Dictionary<string, string> Fractions = new()
    {
        ["1/4"] = "\u00BC", ["1/2"] = "\u00BD", ["3/4"] = "\u00BE",
        ["1/3"] = "\u2153", ["2/3"] = "\u2154",
        ["1/5"] = "\u2155", ["2/5"] = "\u2156", ["3/5"] = "\u2157", ["4/5"] = "\u2158",
        ["1/6"] = "\u2159", ["5/6"] = "\u215A",
        ["1/7"] = "\u2150", ["1/8"] = "\u215B", ["3/8"] = "\u215C", ["5/8"] = "\u215D", ["7/8"] = "\u215E",
        ["1/9"] = "\u2151", ["1/10"] = "\u2152"
    };

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

        // 3. Replace horizontal bar with em dash
        html = html.Replace(HorizontalBar, EmDash);

        // 4. Replace space + en dash with word joiner + em dash
        html = SpaceEnDashRegex().Replace(html, WordJoiner.ToString() + EmDash);

        // 5. Sequential em dashes to two/three em dash characters
        html = html.Replace("\u2014\u2014\u2014", ThreeEmDash.ToString());
        html = html.Replace("\u2014\u2014", TwoEmDash.ToString());

        // 6. Fix smartypants issues with em dashes and quotes
        html = EmDashOpenDoubleQuoteRegex().Replace(html, "\u2014\u201C$1");
        html = EmDashOpenSingleQuoteRegex().Replace(html, "\u2014\u2018$1");

        // 7. Remove stray word joiners (we'll add them back properly)
        html = html.Replace(WordJoiner.ToString(), "");

        // 8. Fix common em-dash transcription errors
        html = ColonDashLetterRegex().Replace(html, "$1\u2014$2");
        html = LetterDashQuoteRegex().Replace(html, "$1\u2014\u201D");

        // 9. Add word joiner before em dashes (prevents break before dash)
        html = BeforeEmDashRegex().Replace(html, "$1\u2060$2");

        // 10. Add en dashes to number ranges (but not inside HTML tags)
        html = NumberRangeRegex().Replace(html, "$1\u2013$2");

        // 11. Add word joiner around en dashes
        html = AroundEnDashRegex().Replace(html, "\u2060\u2013\u2060");

        // 12. Handle title abbreviations with non-breaking space
        html = TitleAbbreviationsRegex().Replace(html, "$1.$2\u00a0");

        // 13. Handle No. with non-breaking space before number
        html = NumberAbbrevRegex().Replace(html, "No$1.\u00a0$2");

        // 14. Handle c/o
        html = CareOfRegex().Replace(html, "\u2105");

        // 15. Fix contractions: 'tis, 'twas, 'twere, etc.
        html = ContractionMissingQuoteRegex().Replace(html, "$1\u2019$2");

        // 16. Fix 'a' abbreviation
        html = AbbrevARegex().Replace(html, "$1\u2019a\u2019$2");

        // 17. Years: '20s, '90s
        html = YearAbbrevRegex().Replace(html, "\u2019$1");

        // 18. Common contractions needing right single quote
        html = CommonContractionsRegex().Replace(html, "\u2019$1");

        // 19. House style: remove spacing from i.e. and e.g.
        html = IeSpacingRegex().Replace(html, "$1.e.");
        html = EgSpacingRegex().Replace(html, "$1.g.");

        // 20. Handle AD/BC era abbreviations (remove periods)
        html = AdSpacingRegex().Replace(html, "$1AD");
        html = BcSpacingRegex().Replace(html, "BC");

        // 21. Hair space between adjacent quotes
        html = AdjacentQuotesRegex1().Replace(html, "\u201D\u200a\u2019");
        html = AdjacentQuotesRegex2().Replace(html, "\u2019\u200a\u201D");
        html = AdjacentQuotesRegex3().Replace(html, "\u201C\u200a\u2018");
        html = AdjacentQuotesRegex4().Replace(html, "\u2018\u200a\u201C");

        // 22. Fix ellipses
        html = ThreeDotsRegex().Replace(html, Ellipsis.ToString());
        html = EllipsisPeriodRegex().Replace(html, ".\u200a\u2026");
        html = EllipsisSpacingRegex().Replace(html, "\u200a\u2026 ");
        html = EllipsisPunctuationRegex().Replace(html, "\u2026\u200a$1");

        // 23. Add word joiner before ellipses with hair space
        html = html.Replace("\u200a\u2026", "\u2060\u200a\u2060\u2026");

        // 24. Non-breaking space between number and abbreviated unit
        html = NumberUnitRegex().Replace(html, "$1\u00a0$2");

        // 25. Non-breaking space between number and AM/PM
        html = TimeAmPmRegex().Replace(html, "$1\u00a0$2.m.");

        // 26. Fractions
        foreach (var (fraction, unicode) in Fractions)
        {
            html = Regex.Replace(html, @"\b(?<!/)(" + Regex.Escape(fraction) + @")(?!/)\b", unicode);
        }

        // 27. Remove space between whole number and fraction
        html = NumberFractionRegex().Replace(html, "$1$2");

        // 28. Unicode minus for negative numbers
        html = NegativeNumberRegex().Replace(html, "$1\u2212$2");

        // 29. Fix possessives after inline elements
        html = PossessiveAfterTagRegex().Replace(html, "</$1>\u2019$2");

        // 30. Fix O.K. to OK
        html = html.Replace("O.K.", "OK");

        // 31. Non-breaking space before &amp;
        html = html.Replace(" &amp;", "\u00a0&amp;");

        // 32. Remove word joiners from img alt attributes
        html = AltAttributeRegex().Replace(html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        // 33. Remove word joiners from title elements
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

    [GeneratedRegex(@"\u2014\u201D(\p{L})")]
    private static partial Regex EmDashOpenDoubleQuoteRegex();

    [GeneratedRegex(@"\u2014\u2019(\p{L})")]
    private static partial Regex EmDashOpenSingleQuoteRegex();

    [GeneratedRegex(@"([:;])-(\p{L})")]
    private static partial Regex ColonDashLetterRegex();

    [GeneratedRegex(@"(\p{L})-\u201D")]
    private static partial Regex LetterDashQuoteRegex();

    [GeneratedRegex(@"([^\s\u2060\u00a0\u200a])([\u2014\u2E3B])")]
    private static partial Regex BeforeEmDashRegex();

    [GeneratedRegex(@"(?<!<[^>]*)(\d+)-(\d+)")]
    private static partial Regex NumberRangeRegex();

    [GeneratedRegex(@"\u2060?\u2013\u2060?")]
    private static partial Regex AroundEnDashRegex();

    [GeneratedRegex(@"\b(Mr|Mrs?|Drs?|Profs?|Lieut|Fr|Lt|Capt|Pvt|Esq|Mt|St|MM|Mmes?|Mlles?|Hon|Mdlle)\.?(</abbr>)?\s+")]
    private static partial Regex TitleAbbreviationsRegex();

    [GeneratedRegex(@"\bNo(s?)\.\s+(\d+)")]
    private static partial Regex NumberAbbrevRegex();

    [GeneratedRegex(@"c/o", RegexOptions.IgnoreCase)]
    private static partial Regex CareOfRegex();

    [GeneratedRegex(@"([\s>])([Tt]is|[Tt]was|[Tt]were|[Tt]won't)\b")]
    private static partial Regex ContractionMissingQuoteRegex();

    [GeneratedRegex(@"(\s)'a'(\s)", RegexOptions.IgnoreCase)]
    private static partial Regex AbbrevARegex();

    [GeneratedRegex(@"'(\d{2,}[^\p{L}0-9'])")]
    private static partial Regex YearAbbrevRegex();

    [GeneratedRegex(@"'([Aa]ve|[Oo]me|[Ii]m|[Mm]idst|[Gg]ainst|[Nn]eath|[Ee]m|[Cc]os|[Tt]is|[Tt]was|[Tt]wixt|[Tt]were|[Tt]would|[Tt]ween|[Tt]will|[Rr]ound|[Pp]on|[Uu]ns?|[Cc]ept|[Oo]w)\b")]
    private static partial Regex CommonContractionsRegex();

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

    [GeneratedRegex(@"(\d)\s+([\u00BC\u00BD\u00BE\u2150\u2151\u2152\u2153\u2154\u2155\u2156\u2157\u2158\u2159\u215A\u215B\u215C\u215D\u215E])")]
    private static partial Regex NumberFractionRegex();

    [GeneratedRegex(@"([\s>])-(\d)")]
    private static partial Regex NegativeNumberRegex();

    [GeneratedRegex(@"</(i|em|b|strong|q|span)>'(s|d)\b")]
    private static partial Regex PossessiveAfterTagRegex();

    [GeneratedRegex(@"alt=""[^""]*?[\u00a0\u2060][^""]*?""")]
    private static partial Regex AltAttributeRegex();

    [GeneratedRegex(@"<title>[^<]*?[\u00a0\u2060][^<]*?</title>")]
    private static partial Regex TitleElementRegex();
}
