using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.Typography;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Typography processor: smart quotes, proper dashes, ellipses, fractions.
/// </summary>
public class TypographyProcessor : ITextProcessor
{
    public string Name => "Typography";
    public int Order => 600;

    private const char Nbsp = '\u00a0';
    private const char WordJoiner = '\u2060';
    private const char HairSpace = '\u200a';
    private const char EmDash = '\u2014';
    private const char EnDash = '\u2013';
    private const char Ellipsis = '\u2026';
    private const char LeftDoubleQuote = '\u201C';
    private const char RightDoubleQuote = '\u201D';
    private const char LeftSingleQuote = '\u2018';
    private const char RightSingleQuote = '\u2019';

    // Compiled regexes
    private static readonly Regex OpeningDoubleQuoteRegex = new(@"(^|[\s>(\[{])""", RegexOptions.Compiled);
    private static readonly Regex ClosingDoubleQuoteRegex = new(@"""([\s<)\]}.,:;!?]|$)", RegexOptions.Compiled);
    private static readonly Regex OpeningSingleQuoteRegex = new(@"(^|[\s>(\[{])'(\p{L})", RegexOptions.Compiled);
    private static readonly Regex ApostropheRegex = new(@"(\p{L})'(\p{L})", RegexOptions.Compiled);
    private static readonly Regex RemainingSingleQuoteRegex = new(@"(\p{L})'", RegexOptions.Compiled);
    private static readonly Regex SingleQuoteBeforeLetterRegex = new(@"'(\p{L})", RegexOptions.Compiled);
    private static readonly Regex SpaceEnDashRegex = new(@"\s\u2013\s?", RegexOptions.Compiled);
    private static readonly Regex ColonDashLetterRegex = new(@"([:;])-(\p{L})", RegexOptions.Compiled);
    private static readonly Regex LetterDashQuoteRegex = new(@"(\p{L})-\u201D", RegexOptions.Compiled);
    private static readonly Regex NumberRangeRegex = new(@"(?<!<[^>]*)(\d+)-(\d+)", RegexOptions.Compiled);
    private static readonly Regex TitleAbbreviationsRegex = new(@"\b(Mr|Mrs?|Drs?|Profs?|Lieut|Fr|Lt|Capt|Pvt|Esq|Mt|St|MM|Mmes?|Mlles?|Hon|Mdlle)\.?(</abbr>)?\s+", RegexOptions.Compiled);
    private static readonly Regex NumberAbbrevRegex = new(@"\bNo(s?)\.\s+(\d+)", RegexOptions.Compiled);
    private static readonly Regex CareOfRegex = new(@"c/o", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex IeSpacingRegex = new(@"([Ii])\.\s+e\.", RegexOptions.Compiled);
    private static readonly Regex EgSpacingRegex = new(@"([Ee])\.\s+g\.", RegexOptions.Compiled);
    private static readonly Regex AdSpacingRegex = new(@"([\d\s])A\.\s*D\.", RegexOptions.Compiled);
    private static readonly Regex BcSpacingRegex = new(@"B\.\s*C\.", RegexOptions.Compiled);
    private static readonly Regex AdjacentQuotesRegex1 = new(@"\u201D[\s\u00a0]*\u2019", RegexOptions.Compiled);
    private static readonly Regex AdjacentQuotesRegex2 = new(@"\u2019[\s\u00a0]*\u201D", RegexOptions.Compiled);
    private static readonly Regex AdjacentQuotesRegex3 = new(@"\u201C[\s\u00a0]*\u2018", RegexOptions.Compiled);
    private static readonly Regex AdjacentQuotesRegex4 = new(@"\u2018[\s\u00a0]*\u201C", RegexOptions.Compiled);
    private static readonly Regex ThreeDotsRegex = new(@"\s*\.\s*\.\s*\.\s*", RegexOptions.Compiled);
    private static readonly Regex EllipsisPeriodRegex = new(@"[\s\u00a0]?\u2026[\s\u00a0]?\.", RegexOptions.Compiled);
    private static readonly Regex EllipsisSpacingRegex = new(@"[\s\u00a0]?\u2026[\s\u00a0]?", RegexOptions.Compiled);
    private static readonly Regex EllipsisPunctuationRegex = new(@"\u2026[\s\u00a0]?([!?.,;])", RegexOptions.Compiled);
    private static readonly Regex EllipsisExclamationRegex = new(@"\u2026([!?])", RegexOptions.Compiled);
    private static readonly Regex NumberUnitRegex = new(@"(\d)\s+(oz\.|lbs?\.)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TimeAmPmRegex = new(@"(\d)\s+([ap])\.m\.", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex NegativeNumberRegex = new(@"([\s>])-(\d)", RegexOptions.Compiled);
    private static readonly Regex AltAttributeRegex = new(@"alt=""[^""]*?[\u00a0\u2060][^""]*?""", RegexOptions.Compiled);
    private static readonly Regex TitleElementRegex = new(@"<title>[^<]*?[\u00a0\u2060][^<]*?</title>", RegexOptions.Compiled);

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;

        // 1. Replace backtick with apostrophe (Gutenberg style)
        html = html.Replace("`", "'");

        // 2. Smart quotes: straight to curly
        html = ApplySmartQuotes(html);

        // 3. Dash processing (horizontal bar, multi-em, word joiners)
        html = Dashes.ProcessDashes(html);

        // 4. Replace space + en dash with word joiner + em dash
        html = SpaceEnDashRegex.Replace(html, WordJoiner.ToString() + EmDash);

        // 5. Fix common em-dash transcription errors
        html = ColonDashLetterRegex.Replace(html, "$1\u2014$2");
        html = LetterDashQuoteRegex.Replace(html, "$1\u2014\u201D");

        // 6. Add en dashes to number ranges (but not inside HTML tags)
        html = NumberRangeRegex.Replace(html, "$1\u2013$2");

        // 7. Handle title abbreviations with non-breaking space
        html = TitleAbbreviationsRegex.Replace(html, "$1.$2\u00a0");

        // 8. Handle No. with non-breaking space before number
        html = NumberAbbrevRegex.Replace(html, "No$1.\u00a0$2");

        // 9. Handle c/o
        html = CareOfRegex.Replace(html, "\u2105");

        // 10. Fix archaic contractions ('tis, 'twas, etc.)
        html = Contractions.FixArchaicContractions(html);

        // 11. Fix possessives after inline elements (</i>'s)
        html = Contractions.FixPossessivesAfterTags(html);

        // 12. House style: remove spacing from i.e. and e.g.
        html = IeSpacingRegex.Replace(html, "$1.e.");
        html = EgSpacingRegex.Replace(html, "$1.g.");

        // 13. Handle AD/BC era abbreviations (remove periods)
        html = AdSpacingRegex.Replace(html, "$1AD");
        html = BcSpacingRegex.Replace(html, "BC");

        // 14. Hair space between adjacent quotes
        html = AdjacentQuotesRegex1.Replace(html, "\u201D\u200a\u2019");
        html = AdjacentQuotesRegex2.Replace(html, "\u2019\u200a\u201D");
        html = AdjacentQuotesRegex3.Replace(html, "\u201C\u200a\u2018");
        html = AdjacentQuotesRegex4.Replace(html, "\u2018\u200a\u201C");

        // 15. Fix ellipses
        html = ThreeDotsRegex.Replace(html, Ellipsis.ToString());
        html = EllipsisPeriodRegex.Replace(html, ".\u200a\u2026");
        html = EllipsisSpacingRegex.Replace(html, "\u200a\u2026 ");
        html = EllipsisPunctuationRegex.Replace(html, "\u2026\u200a$1");
        // Ellipsis with exclamation/question: …! → .⁠ ⁠…! (period before trailing ellipsis)
        html = EllipsisExclamationRegex.Replace(html, ".\u2060\u200a\u2060\u2026$1");

        // 16. Add word joiner before ellipses with hair space
        html = html.Replace("\u200a\u2026", "\u2060\u200a\u2060\u2026");

        // 17. Non-breaking space between number and abbreviated unit
        html = NumberUnitRegex.Replace(html, "$1\u00a0$2");

        // 18. Non-breaking space between number and AM/PM
        html = TimeAmPmRegex.Replace(html, "$1\u00a0$2.m.");

        // 19. Extended fractions
        html = Fractions.ConvertFractions(html);

        // 20. Unicode minus for negative numbers
        html = NegativeNumberRegex.Replace(html, "$1\u2212$2");

        // 21. Historical currency normalization (L -> GBP symbol)
        html = Currency.NormalizeCurrency(html);

        // 22. Scottish/Irish name normalization
        html = Names.NormalizeNames(html);

        // 23. Fix O.K. to OK
        html = html.Replace("O.K.", "OK");

        // 24. Non-breaking space before &amp;
        html = html.Replace(" &amp;", "\u00a0&amp;");

        // 25. Remove word joiners from img alt attributes
        html = AltAttributeRegex.Replace(html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        // 26. Remove word joiners from title elements
        html = TitleElementRegex.Replace(html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        return html;
    }

    private static string ApplySmartQuotes(string html)
    {
        html = OpeningDoubleQuoteRegex.Replace(html, "$1\u201C");
        html = ClosingDoubleQuoteRegex.Replace(html, "\u201D$1");
        html = html.Replace("\"", "\u201D");
        html = OpeningSingleQuoteRegex.Replace(html, "$1\u2018$2");
        html = ApostropheRegex.Replace(html, "$1\u2019$2");
        html = RemainingSingleQuoteRegex.Replace(html, "$1\u2019");
        html = SingleQuoteBeforeLetterRegex.Replace(html, "\u2018$1");
        return html;
    }
}
