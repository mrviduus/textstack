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

    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(100);

    // Compiled regexes with timeout
    private static readonly Regex OpeningDoubleQuoteRegex = new(@"(^|[\s>(\[{])""", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ClosingDoubleQuoteRegex = new(@"""([\s<)\]}.,:;!?]|$)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex OpeningSingleQuoteRegex = new(@"(^|[\s>(\[{])'(\p{L})", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ApostropheRegex = new(@"(\p{L})'(\p{L})", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex RemainingSingleQuoteRegex = new(@"(\p{L})'", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex SingleQuoteBeforeLetterRegex = new(@"'(\p{L})", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex SpaceEnDashRegex = new(@"\s\u2013\s?", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ColonDashLetterRegex = new(@"([:;])-(\p{L})", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex LetterDashQuoteRegex = new(@"(\p{L})-\u201D", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex NumberRangeRegex = new(@"(?<!<[^>]*)(\d+)-(\d+)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex TitleAbbreviationsRegex = new(@"\b(Mr|Mrs?|Drs?|Profs?|Lieut|Fr|Lt|Capt|Pvt|Esq|Mt|St|MM|Mmes?|Mlles?|Hon|Mdlle)\.?(</abbr>)?\s+", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex NumberAbbrevRegex = new(@"\bNo(s?)\.\s+(\d+)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex CareOfRegex = new(@"c/o", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex IeSpacingRegex = new(@"([Ii])\.\s+e\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EgSpacingRegex = new(@"([Ee])\.\s+g\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdSpacingRegex = new(@"([\d\s])A\.\s*D\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex BcSpacingRegex = new(@"B\.\s*C\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdjacentQuotesRegex1 = new(@"\u201D[\s\u00a0]*\u2019", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdjacentQuotesRegex2 = new(@"\u2019[\s\u00a0]*\u201D", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdjacentQuotesRegex3 = new(@"\u201C[\s\u00a0]*\u2018", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdjacentQuotesRegex4 = new(@"\u2018[\s\u00a0]*\u201C", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ThreeDotsRegex = new(@"\s*\.\s*\.\s*\.\s*", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EllipsisPeriodRegex = new(@"[\s\u00a0]?\u2026[\s\u00a0]?\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EllipsisSpacingRegex = new(@"[\s\u00a0]?\u2026[\s\u00a0]?", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EllipsisPunctuationRegex = new(@"\u2026[\s\u00a0]?([!?.,;])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EllipsisExclamationRegex = new(@"\u2026([!?])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex NumberUnitRegex = new(@"(\d)\s+(oz\.|lbs?\.)", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex TimeAmPmRegex = new(@"(\d)\s+([ap])\.m\.", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex NegativeNumberRegex = new(@"([\s>])-(\d)", RegexOptions.Compiled, RegexTimeout);

    // These patterns had potential backtracking issues - simplified with possessive-like approach
    // Using atomic groups via non-backtracking where possible, with explicit bounds
    private static readonly Regex AltAttributeRegex = new(@"alt=""[^""]{0,1000}[\u00a0\u2060][^""]{0,1000}""", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex TitleElementRegex = new(@"<title>[^<]{0,1000}[\u00a0\u2060][^<]{0,1000}</title>", RegexOptions.Compiled, RegexTimeout);

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
        html = SafeReplace(SpaceEnDashRegex, html, WordJoiner.ToString() + EmDash);

        // 5. Fix common em-dash transcription errors
        html = SafeReplace(ColonDashLetterRegex, html, "$1\u2014$2");
        html = SafeReplace(LetterDashQuoteRegex, html, "$1\u2014\u201D");

        // 6. Add en dashes to number ranges (but not inside HTML tags)
        html = SafeReplace(NumberRangeRegex, html, "$1\u2013$2");

        // 7. Handle title abbreviations with non-breaking space
        html = SafeReplace(TitleAbbreviationsRegex, html, "$1.$2\u00a0");

        // 8. Handle No. with non-breaking space before number
        html = SafeReplace(NumberAbbrevRegex, html, "No$1.\u00a0$2");

        // 9. Handle c/o
        html = SafeReplace(CareOfRegex, html, "\u2105");

        // 10. Fix archaic contractions ('tis, 'twas, etc.)
        html = Contractions.FixArchaicContractions(html);

        // 11. Fix possessives after inline elements (</i>'s)
        html = Contractions.FixPossessivesAfterTags(html);

        // 12. House style: remove spacing from i.e. and e.g.
        html = SafeReplace(IeSpacingRegex, html, "$1.e.");
        html = SafeReplace(EgSpacingRegex, html, "$1.g.");

        // 13. Handle AD/BC era abbreviations (remove periods)
        html = SafeReplace(AdSpacingRegex, html, "$1AD");
        html = SafeReplace(BcSpacingRegex, html, "BC");

        // 14. Hair space between adjacent quotes
        html = SafeReplace(AdjacentQuotesRegex1, html, "\u201D\u200a\u2019");
        html = SafeReplace(AdjacentQuotesRegex2, html, "\u2019\u200a\u201D");
        html = SafeReplace(AdjacentQuotesRegex3, html, "\u201C\u200a\u2018");
        html = SafeReplace(AdjacentQuotesRegex4, html, "\u2018\u200a\u201C");

        // 15. Fix ellipses
        html = SafeReplace(ThreeDotsRegex, html, Ellipsis.ToString());
        html = SafeReplace(EllipsisPeriodRegex, html, ".\u200a\u2026");
        html = SafeReplace(EllipsisSpacingRegex, html, "\u200a\u2026 ");
        html = SafeReplace(EllipsisPunctuationRegex, html, "\u2026\u200a$1");
        // Ellipsis with exclamation/question: …! → .⁠ ⁠…! (period before trailing ellipsis)
        html = SafeReplace(EllipsisExclamationRegex, html, ".\u2060\u200a\u2060\u2026$1");

        // 16. Add word joiner before ellipses with hair space
        html = html.Replace("\u200a\u2026", "\u2060\u200a\u2060\u2026");

        // 17. Non-breaking space between number and abbreviated unit
        html = SafeReplace(NumberUnitRegex, html, "$1\u00a0$2");

        // 18. Non-breaking space between number and AM/PM
        html = SafeReplace(TimeAmPmRegex, html, "$1\u00a0$2.m.");

        // 19. Extended fractions
        html = Fractions.ConvertFractions(html);

        // 20. Unicode minus for negative numbers
        html = SafeReplace(NegativeNumberRegex, html, "$1\u2212$2");

        // 21. Historical currency normalization (L -> GBP symbol)
        html = Currency.NormalizeCurrency(html);

        // 22. Scottish/Irish name normalization
        html = Names.NormalizeNames(html);

        // 23. Fix O.K. to OK
        html = html.Replace("O.K.", "OK");

        // 24. Non-breaking space before &amp;
        html = html.Replace(" &amp;", "\u00a0&amp;");

        // 25. Remove word joiners from img alt attributes
        html = SafeReplace(AltAttributeRegex, html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        // 26. Remove word joiners from title elements
        html = SafeReplace(TitleElementRegex, html, m =>
            m.Value.Replace("\u00a0", " ").Replace("\u2060", ""));

        return html;
    }

    private static string ApplySmartQuotes(string html)
    {
        html = SafeReplace(OpeningDoubleQuoteRegex, html, "$1\u201C");
        html = SafeReplace(ClosingDoubleQuoteRegex, html, "\u201D$1");
        html = html.Replace("\"", "\u201D");
        html = SafeReplace(OpeningSingleQuoteRegex, html, "$1\u2018$2");
        html = SafeReplace(ApostropheRegex, html, "$1\u2019$2");
        html = SafeReplace(RemainingSingleQuoteRegex, html, "$1\u2019");
        html = SafeReplace(SingleQuoteBeforeLetterRegex, html, "\u2018$1");
        return html;
    }

    private static string SafeReplace(Regex regex, string input, string replacement)
    {
        try
        {
            return regex.Replace(input, replacement);
        }
        catch (RegexMatchTimeoutException)
        {
            return input;
        }
    }

    private static string SafeReplace(Regex regex, string input, MatchEvaluator evaluator)
    {
        try
        {
            return regex.Replace(input, evaluator);
        }
        catch (RegexMatchTimeoutException)
        {
            return input;
        }
    }
}
