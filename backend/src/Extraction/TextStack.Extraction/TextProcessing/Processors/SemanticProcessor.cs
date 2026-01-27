using System.Text.RegularExpressions;
using TextStack.Extraction.Semantic;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Adds semantic HTML markup: abbreviations, roman numerals, measurements, eras.
/// </summary>
public class SemanticProcessor : ITextProcessor
{
    public string Name => "Semantic";
    public int Order => 700;

    private const char Nbsp = '\u00a0';

    private static readonly string[] NameTitles =
    [
        "Capt", "Col", "Dr", "Drs", "Esq", "Fr", "Hon", "Lieut", "Lt",
        "MM", "Mdlle", "Messers", "Messrs", "Mlle", "Mlles", "Mme", "Mmes",
        "Mon", "Mr", "Mrs", "Ms", "Prof", "Pvt", "Rev"
    ];

    // Compiled regexes
    private static readonly Regex InitialismRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(M\.?P\.?|H\.?M\.?S\.?|S\.?S\.?|N\.?B\.?|W\.?C\.?|I\.?O\.?U\.?)(?!\b)", RegexOptions.Compiled);
    private static readonly Regex InitialismTitleRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(R\.?A\.?|M\.?A\.?|M\.?D\.?|K\.?C\.?|Q\.?C\.?)(?!\b)", RegexOptions.Compiled);
    private static readonly Regex UsaRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))U\.?S\.?A\.?(?!\b)", RegexOptions.Compiled);
    private static readonly Regex CompassRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([NESW]\.?[NESW]\.?)(?!\b)", RegexOptions.Compiled);
    private static readonly Regex BrosRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))Bros\.", RegexOptions.Compiled);
    private static readonly Regex MtRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))Mt\.", RegexOptions.Compiled);
    private static readonly Regex VolRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])ol(s?)\.", RegexOptions.Compiled);
    private static readonly Regex ChapRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Cc])hap\. (\d)", RegexOptions.Compiled);
    private static readonly Regex CoIncLtdStRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(Co\.|Inc\.|Ltd\.|St\.)", RegexOptions.Compiled);
    private static readonly Regex GovRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Gg])ov\.", RegexOptions.Compiled);
    private static readonly Regex MsAbbrevRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))MS(S?)\.", RegexOptions.Compiled);
    private static readonly Regex VizRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])iz\.", RegexOptions.Compiled);
    private static readonly Regex EtcRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))etc\.", RegexOptions.Compiled);
    private static readonly Regex CfRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Cc])f\.", RegexOptions.Compiled);
    private static readonly Regex EdRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))ed\.", RegexOptions.Compiled);
    private static readonly Regex VsRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])s\.", RegexOptions.Compiled);
    private static readonly Regex FfRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ff])f\.", RegexOptions.Compiled);
    private static readonly Regex LibRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ll])ib\.", RegexOptions.Compiled);
    private static readonly Regex PpRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))p(p?)\.([\s\d])", RegexOptions.Compiled);
    private static readonly Regex IeRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ii])\.e\.", RegexOptions.Compiled);
    private static readonly Regex EgRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ee])\.g\.", RegexOptions.Compiled);
    private static readonly Regex MonthsRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\.)", RegexOptions.Compiled);
    private static readonly Regex NoRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))No(s?)\.([\s\d])", RegexOptions.Compiled);
    private static readonly Regex PsRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>)|\.)(P\.(?:P\.)?S\.(?:S\.)?\B)", RegexOptions.Compiled);
    private static readonly Regex PhdRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))Ph\.?\s*D\.?", RegexOptions.Compiled);
    private static readonly Regex AmPmRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))([ap])\.\s?m\.", RegexOptions.Compiled);
    private static readonly Regex TimeAmPmNumRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(\d{1,2})\s?[Aa]\.?\s?[Mm](?:\.|\b)", RegexOptions.Compiled);
    private static readonly Regex AdEraRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))A\.?D\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])", RegexOptions.Compiled);
    private static readonly Regex BcEraRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))B\.?C\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])", RegexOptions.Compiled);
    private static readonly Regex AdInlineRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?:AD\b|A\.D\.\B)", RegexOptions.Compiled);
    private static readonly Regex BcInlineRegex = new(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?:BC\b|B\.C\.\B)", RegexOptions.Compiled);
    private static readonly Regex RomanNumeralsRegex = new(@"(?<![<>/\u0022\u0027])\b(?=[CDILMVX]{2,})(?!MI\b|DI\b|MIX\b)(M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3}))\b(?![\w\u0027>-])", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ValidRomanRegex = new(@"^M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3})$", RegexOptions.Compiled);
    private static readonly Regex SingleIRomanRegex = new(@"([^\p{L}<>/\u0022\u0027])i\b(?![\u0027\u2011-])(?![^<>]+>)", RegexOptions.Compiled);
    private static readonly Regex SiMeasurementsRegex = new(@"(\d+)\s*([cmk][mgl])\b", RegexOptions.Compiled);
    private static readonly Regex ImperialMeasurementsRegex = new(@"(?<![\$\u00A3\d,])(\d+)\s*(ft|yd|yds|mi|pt|qt|gal|oz|lb|lbs)\.?(\W)", RegexOptions.Compiled);
    private static readonly Regex InchesRegex = new(@"(?<![\$\u00A3\d,])(\d+)\s*in\.(\b|[\s,:;!?])", RegexOptions.Compiled);
    private static readonly Regex MphRegex = new(@"(\d+)\s*m\.?p\.?h\.?", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex HpRegex = new(@"(\d+)\s*h\.?p\.?", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex EocEtcRegex = new(@"<abbr>etc\.</abbr>([\u201C\u201D\u2018\u2019]?(?:</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}]))", RegexOptions.Compiled);
    private static readonly Regex EocGeneralRegex = new(@"<abbr( epub:type=\u0022[^\u0022]+\u0022)?>([^<]+\.)</abbr>([\u201C\u201D\u2018\u2019]?</p>)", RegexOptions.Compiled);

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;

        // 1. Name title abbreviations
        foreach (var title in NameTitles)
        {
            html = Regex.Replace(
                html,
                @"(?<!(?:\.|\B|<abbr[^>]*?>))(" + Regex.Escape(title) + @")\.(?!</abbr>)",
                "<abbr epub:type=\"z3998:name-title\">" + title + ".</abbr>");
        }

        // 2. Common initialisms
        html = InitialismRegex.Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism\">" + formatted + "</abbr>";
        });

        // 3. Initialisms that are also titles
        html = InitialismTitleRegex.Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism z3998:name-title\">" + formatted + "</abbr>";
        });

        // 4. USA
        html = UsaRegex.Replace(html, "<abbr epub:type=\"z3998:initialism z3998:place\">U.S.A.</abbr>");

        // 5. Compass directions
        html = CompassRegex.Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"se:compass\">" + formatted + "</abbr>";
        });

        // 6. Simple abbreviations
        html = BrosRegex.Replace(html, "<abbr>Bros.</abbr>");
        html = MtRegex.Replace(html, "<abbr>Mt.</abbr>");
        html = VolRegex.Replace(html, "<abbr>$1ol$2.</abbr>");
        html = ChapRegex.Replace(html, "<abbr>$1hap.</abbr> $2");
        html = CoIncLtdStRegex.Replace(html, "<abbr>$1</abbr>");
        html = GovRegex.Replace(html, "<abbr>$1ov.</abbr>");
        html = MsAbbrevRegex.Replace(html, "<abbr>MS$1.</abbr>");
        html = VizRegex.Replace(html, "<abbr>$1iz.</abbr>");
        html = EtcRegex.Replace(html, "<abbr>etc.</abbr>");
        html = CfRegex.Replace(html, "<abbr>$1f.</abbr>");
        html = EdRegex.Replace(html, "<abbr>ed.</abbr>");
        html = VsRegex.Replace(html, "<abbr>$1s.</abbr>");
        html = FfRegex.Replace(html, "<abbr>$1f.</abbr>");
        html = LibRegex.Replace(html, "<abbr>$1ib.</abbr>");
        html = PpRegex.Replace(html, "<abbr>p$1.</abbr>$2");

        // 7. Latin abbreviations
        html = IeRegex.Replace(html, "<abbr epub:type=\"z3998:initialism\">$1.e.</abbr>");
        html = EgRegex.Replace(html, "<abbr epub:type=\"z3998:initialism\">$1.g.</abbr>");

        // 8. Month abbreviations
        html = MonthsRegex.Replace(html, "<abbr>$1</abbr>");

        // 9. No. abbreviation
        html = NoRegex.Replace(html, "<abbr>No$1.</abbr>$2");

        // 10. P.S., P.P.S.
        html = PsRegex.Replace(html, "<abbr epub:type=\"z3998:initialism\">$1</abbr>");

        // 11. Ph.D.
        html = PhdRegex.Replace(html, "<abbr epub:type=\"z3998:name-title\">Ph. D.</abbr>");

        // 12. a.m./p.m.
        html = AmPmRegex.Replace(html, "<abbr>$1.m.</abbr>");
        html = TimeAmPmNumRegex.Replace(html, "$1 <abbr>$2.m.</abbr>");

        // 13. AD/BC era dates
        html = AdEraRegex.Replace(html, "<abbr epub:type=\"se:era\">AD</abbr>.$1");
        html = BcEraRegex.Replace(html, "<abbr epub:type=\"se:era\">BC</abbr>.$1");
        html = AdInlineRegex.Replace(html, "<abbr epub:type=\"se:era\">AD</abbr>");
        html = BcInlineRegex.Replace(html, "<abbr epub:type=\"se:era\">BC</abbr>");

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

    private static bool IsValidRomanNumeral(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        s = s.ToUpperInvariant();
        if (s is "MI" or "DI" or "MIX" or "ID" or "LI" or "MIC" or "VIM" or "DIV" or "DIM")
            return false;
        return ValidRomanRegex.IsMatch(s);
    }
}
