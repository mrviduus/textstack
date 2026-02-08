using System.Text.RegularExpressions;
using TextStack.Extraction.Semantic;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Adds semantic HTML markup: abbreviations, roman numerals, measurements, eras.
/// Uses a two-pass approach to avoid catastrophic backtracking from lookbehinds.
/// </summary>
public class SemanticProcessor : ITextProcessor
{
    public string Name => "Semantic";
    public int Order => 700;

    private const char Nbsp = '\u00a0';
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(100);

    private static readonly string[] NameTitles =
    [
        "Capt", "Col", "Dr", "Drs", "Esq", "Fr", "Hon", "Lieut", "Lt",
        "MM", "Mdlle", "Messers", "Messrs", "Mlle", "Mlles", "Mme", "Mmes",
        "Mon", "Mr", "Mrs", "Ms", "Prof", "Pvt", "Rev"
    ];

    // Pattern definitions without lookbehinds - we'll validate context in MatchEvaluator
    private static readonly Regex InitialismRegex = new(@"\b(M\.?P\.?|H\.?M\.?S\.?|S\.?S\.?|N\.?B\.?|W\.?C\.?|I\.?O\.?U\.?)\b", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex InitialismTitleRegex = new(@"\b(R\.?A\.?|M\.?A\.?|M\.?D\.?|K\.?C\.?|Q\.?C\.?)\b", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex UsaRegex = new(@"\bU\.?S\.?A\.?\b", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex CompassRegex = new(@"\b([NESW]\.?[NESW]\.?)\b", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex BrosRegex = new(@"\bBros\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex MtRegex = new(@"\bMt\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex VolRegex = new(@"\b([Vv])ol(s?)\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ChapRegex = new(@"\b([Cc])hap\. (\d)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex CoIncLtdStRegex = new(@"\b(Co\.|Inc\.|Ltd\.|St\.)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex GovRegex = new(@"\b([Gg])ov\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex MsAbbrevRegex = new(@"\bMS(S?)\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex VizRegex = new(@"\b([Vv])iz\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EtcRegex = new(@"\betc\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex CfRegex = new(@"\b([Cc])f\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EdRegex = new(@"\bed\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex VsRegex = new(@"\b([Vv])s\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex FfRegex = new(@"\b([Ff])f\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex LibRegex = new(@"\b([Ll])ib\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex PpRegex = new(@"\bp(p?)\.([\s\d])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex IeRegex = new(@"\b([Ii])\.e\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EgRegex = new(@"\b([Ee])\.g\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex MonthsRegex = new(@"\b(Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\.)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex NoRegex = new(@"\bNo(s?)\.([\s\d])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex PsRegex = new(@"\b(P\.(?:P\.)?S\.(?:S\.)?)\B", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex PhdRegex = new(@"\bPh\.?\s*D\.?", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AmPmRegex = new(@"\b([ap])\.\s?m\.", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex TimeAmPmNumRegex = new(@"(\d{1,2})\s?[Aa]\.?\s?[Mm](?:\.|\b)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdEraRegex = new(@"\bA\.?D\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex BcEraRegex = new(@"\bB\.?C\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex AdInlineRegex = new(@"\b(?:AD\b|A\.D\.\B)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex BcInlineRegex = new(@"\b(?:BC\b|B\.C\.\B)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex RomanNumeralsRegex = new(@"(?<![<>/\u0022\u0027])\b(?=[CDILMVX]{2,})(?!MI\b|DI\b|MIX\b)(M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3}))\b(?![\w\u0027>-])", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ValidRomanRegex = new(@"^M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3})$", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex SingleIRomanRegex = new(@"([^\p{L}<>/\u0022\u0027])i\b(?![\u0027\u2011-])(?![^<>]+>)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex SiMeasurementsRegex = new(@"(\d+)\s*([cmk][mgl])\b", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex ImperialMeasurementsRegex = new(@"(?<![\$\u00A3\d,])(\d+)\s*(ft|yd|yds|mi|pt|qt|gal|oz|lb|lbs)\.?(\W)", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex InchesRegex = new(@"(?<![\$\u00A3\d,])(\d+)\s*in\.(\b|[\s,:;!?])", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex MphRegex = new(@"(\d+)\s*m\.?p\.?h\.?", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex HpRegex = new(@"(\d+)\s*h\.?p\.?", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EocEtcRegex = new(@"<abbr>etc\.</abbr>([\u201C\u201D\u2018\u2019]?(?:</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}]))", RegexOptions.Compiled, RegexTimeout);
    private static readonly Regex EocGeneralRegex = new(@"<abbr( epub:type=\u0022[^\u0022]+\u0022)?>([^<]+\.)</abbr>([\u201C\u201D\u2018\u2019]?</p>)", RegexOptions.Compiled, RegexTimeout);

    // Regex to find existing abbr tags for pre-filtering
    private static readonly Regex AbbrTagRegex = new(@"<abbr[^>]*>.*?</abbr>", RegexOptions.Compiled | RegexOptions.Singleline, RegexTimeout);

    // Name title patterns without lookbehinds
    private static readonly Dictionary<string, Regex> NameTitleRegexes = NameTitles.ToDictionary(
        title => title,
        title => new Regex(@"\b" + Regex.Escape(title) + @"\.(?!</abbr>)", RegexOptions.Compiled, RegexTimeout)
    );

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;

        // Two-pass approach: first find all <abbr> tag positions, then skip matches inside them
        var abbrRanges = GetAbbrRanges(html);

        // 1. Name title abbreviations
        foreach (var title in NameTitles)
        {
            html = SafeReplace(html, NameTitleRegexes[title], abbrRanges,
                _ => "<abbr epub:type=\"z3998:name-title\">" + title + ".</abbr>");
            abbrRanges = GetAbbrRanges(html); // Update ranges after replacement
        }

        // 2. Common initialisms
        html = SafeReplace(html, InitialismRegex, abbrRanges, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism\">" + formatted + "</abbr>";
        });
        abbrRanges = GetAbbrRanges(html);

        // 3. Initialisms that are also titles
        html = SafeReplace(html, InitialismTitleRegex, abbrRanges, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism z3998:name-title\">" + formatted + "</abbr>";
        });
        abbrRanges = GetAbbrRanges(html);

        // 4. USA
        html = SafeReplace(html, UsaRegex, abbrRanges, _ => "<abbr epub:type=\"z3998:initialism z3998:place\">U.S.A.</abbr>");
        abbrRanges = GetAbbrRanges(html);

        // 5. Compass directions
        html = SafeReplace(html, CompassRegex, abbrRanges, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"se:compass\">" + formatted + "</abbr>";
        });
        abbrRanges = GetAbbrRanges(html);

        // 6. Simple abbreviations
        html = SafeReplace(html, BrosRegex, abbrRanges, _ => "<abbr>Bros.</abbr>");
        html = SafeReplace(html, MtRegex, GetAbbrRanges(html), _ => "<abbr>Mt.</abbr>");
        html = SafeReplace(html, VolRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "ol" + m.Groups[2].Value + ".</abbr>");
        html = SafeReplace(html, ChapRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "hap.</abbr> " + m.Groups[2].Value);
        html = SafeReplace(html, CoIncLtdStRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "</abbr>");
        html = SafeReplace(html, GovRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "ov.</abbr>");
        html = SafeReplace(html, MsAbbrevRegex, GetAbbrRanges(html), m => "<abbr>MS" + m.Groups[1].Value + ".</abbr>");
        html = SafeReplace(html, VizRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "iz.</abbr>");
        html = SafeReplace(html, EtcRegex, GetAbbrRanges(html), _ => "<abbr>etc.</abbr>");
        html = SafeReplace(html, CfRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "f.</abbr>");
        html = SafeReplace(html, EdRegex, GetAbbrRanges(html), _ => "<abbr>ed.</abbr>");
        html = SafeReplace(html, VsRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "s.</abbr>");
        html = SafeReplace(html, FfRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "f.</abbr>");
        html = SafeReplace(html, LibRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "ib.</abbr>");
        html = SafeReplace(html, PpRegex, GetAbbrRanges(html), m => "<abbr>p" + m.Groups[1].Value + ".</abbr>" + m.Groups[2].Value);

        // 7. Latin abbreviations
        html = SafeReplace(html, IeRegex, GetAbbrRanges(html), m => "<abbr epub:type=\"z3998:initialism\">" + m.Groups[1].Value + ".e.</abbr>");
        html = SafeReplace(html, EgRegex, GetAbbrRanges(html), m => "<abbr epub:type=\"z3998:initialism\">" + m.Groups[1].Value + ".g.</abbr>");

        // 8. Month abbreviations
        html = SafeReplace(html, MonthsRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + "</abbr>");

        // 9. No. abbreviation
        html = SafeReplace(html, NoRegex, GetAbbrRanges(html), m => "<abbr>No" + m.Groups[1].Value + ".</abbr>" + m.Groups[2].Value);

        // 10. P.S., P.P.S.
        html = SafeReplace(html, PsRegex, GetAbbrRanges(html), m => "<abbr epub:type=\"z3998:initialism\">" + m.Groups[1].Value + "</abbr>");

        // 11. Ph.D.
        html = SafeReplace(html, PhdRegex, GetAbbrRanges(html), _ => "<abbr epub:type=\"z3998:name-title\">Ph. D.</abbr>");

        // 12. a.m./p.m.
        html = SafeReplace(html, AmPmRegex, GetAbbrRanges(html), m => "<abbr>" + m.Groups[1].Value + ".m.</abbr>");
        html = SafeReplace(html, TimeAmPmNumRegex, GetAbbrRanges(html), m => m.Groups[1].Value + " <abbr>" + m.Groups[2].Value + ".m.</abbr>");

        // 13. AD/BC era dates
        html = SafeReplace(html, AdEraRegex, GetAbbrRanges(html), m => "<abbr epub:type=\"se:era\">AD</abbr>." + m.Groups[1].Value);
        html = SafeReplace(html, BcEraRegex, GetAbbrRanges(html), m => "<abbr epub:type=\"se:era\">BC</abbr>." + m.Groups[1].Value);
        html = SafeReplace(html, AdInlineRegex, GetAbbrRanges(html), _ => "<abbr epub:type=\"se:era\">AD</abbr>");
        html = SafeReplace(html, BcInlineRegex, GetAbbrRanges(html), _ => "<abbr epub:type=\"se:era\">BC</abbr>");

        // 14. SI measurements
        html = SiMeasurementsRegex.Replace(html, "$1" + Nbsp + "<abbr>$2</abbr>");

        // 15. Imperial measurements
        html = ImperialMeasurementsRegex.Replace(html, "$1" + Nbsp + "<abbr>$2.</abbr>$3");

        // 16. Inches
        html = InchesRegex.Replace(html, "$1" + Nbsp + "<abbr>in.</abbr>$2");

        // 17. Speed
        html = MphRegex.Replace(html, "$1" + Nbsp + "<abbr>mph</abbr>");
        html = HpRegex.Replace(html, "$1" + Nbsp + "<abbr>hp</abbr>");

        // 18. Roman numerals
        html = RomanNumeralsRegex.Replace(html, m =>
        {
            var numeral = m.Groups[1].Value;
            if (IsValidRomanNumeral(numeral))
                return "<span epub:type=\"z3998:roman\">" + numeral + "</span>";
            return m.Value;
        });

        // 19. Single lowercase 'i' as roman numeral
        html = SingleIRomanRegex.Replace(html, "$1<span epub:type=\"z3998:roman\">i</span>");

        // 20. Add "eoc" class for end-of-clause abbreviations
        html = EocEtcRegex.Replace(html, "<abbr class=\"eoc\">etc.</abbr>$1");
        html = EocGeneralRegex.Replace(html, "<abbr class=\"eoc\"$1>$2</abbr>$3");

        // 21. Extended abbreviations
        html = Abbreviations.MarkupExtendedAbbreviations(html);

        return html;
    }

    /// <summary>
    /// Get ranges of all abbr tags in the text.
    /// </summary>
    private static List<(int Start, int End)> GetAbbrRanges(string html)
    {
        var ranges = new List<(int Start, int End)>();
        try
        {
            foreach (Match m in AbbrTagRegex.Matches(html))
            {
                ranges.Add((m.Index, m.Index + m.Length));
            }
        }
        catch (RegexMatchTimeoutException)
        {
            // If we can't find abbr tags, return empty - safer to not skip anything
        }
        return ranges;
    }

    /// <summary>
    /// Check if position is inside any abbr tag range.
    /// </summary>
    private static bool IsInsideAbbrTag(int position, List<(int Start, int End)> ranges)
    {
        foreach (var (start, end) in ranges)
        {
            if (position >= start && position < end)
                return true;
        }
        return false;
    }

    /// <summary>
    /// Replace matches but skip those inside existing abbr tags.
    /// </summary>
    private static string SafeReplace(string input, Regex regex, List<(int Start, int End)> abbrRanges, Func<Match, string> evaluator)
    {
        try
        {
            return regex.Replace(input, m =>
            {
                // Skip if match is inside an existing abbr tag
                if (IsInsideAbbrTag(m.Index, abbrRanges))
                    return m.Value;
                return evaluator(m);
            });
        }
        catch (RegexMatchTimeoutException)
        {
            return input; // Return unmodified on timeout
        }
    }

    private static bool IsValidRomanNumeral(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        s = s.ToUpperInvariant();
        if (s is "MI" or "DI" or "MIX" or "ID" or "LI" or "MIC" or "VIM" or "DIV" or "DIM")
            return false;
        try
        {
            return ValidRomanRegex.IsMatch(s);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }
}
