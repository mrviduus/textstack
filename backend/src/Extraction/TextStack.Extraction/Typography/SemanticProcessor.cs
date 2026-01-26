using System.Text.RegularExpressions;
using TextStack.Extraction.Semantic;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Semantic processor ported from Standard Ebooks formatting.py semanticate().
/// Adds semantic markup: abbreviations, roman numerals, measurements, eras.
/// </summary>
public static partial class SemanticProcessor
{
    private const char Nbsp = '\u00a0';

    // Title abbreviations that get epub:type="z3998:name-title"
    private static readonly string[] NameTitles =
    [
        "Capt", "Col", "Dr", "Drs", "Esq", "Fr", "Hon", "Lieut", "Lt",
        "MM", "Mdlle", "Messers", "Messrs", "Mlle", "Mlles", "Mme", "Mmes",
        "Mon", "Mr", "Mrs", "Ms", "Prof", "Pvt", "Rev"
    ];

    /// <summary>
    /// Add semantic HTML markup to content.
    /// </summary>
    public static string Semanticate(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // 1. Name title abbreviations: Mr. to <abbr epub:type="z3998:name-title">Mr.</abbr>
        foreach (var title in NameTitles)
        {
            html = Regex.Replace(
                html,
                @"(?<!(?:\.|\B|<abbr[^>]*?>))(" + Regex.Escape(title) + @")\.(?!</abbr>)",
                "<abbr epub:type=\"z3998:name-title\">" + title + ".</abbr>");
        }

        // 2. Common initialisms: MP, HMS, SS, NB, WC, IOU
        html = InitialismRegex().Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism\">" + formatted + "</abbr>";
        });

        // 3. Initialisms that are also titles: RA, MA, MD, KC, QC
        html = InitialismTitleRegex().Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"z3998:initialism z3998:name-title\">" + formatted + "</abbr>";
        });

        // 4. USA
        html = UsaRegex().Replace(html, "<abbr epub:type=\"z3998:initialism z3998:place\">U.S.A.</abbr>");

        // 5. Compass directions: NE, SW, etc.
        html = CompassRegex().Replace(html, m =>
        {
            var normalized = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", normalized.ToCharArray()) + ".";
            return "<abbr epub:type=\"se:compass\">" + formatted + "</abbr>";
        });

        // 6. Simple abbreviations without epub:type
        html = BrosRegex().Replace(html, "<abbr>Bros.</abbr>");
        html = MtRegex().Replace(html, "<abbr>Mt.</abbr>");
        html = VolRegex().Replace(html, "<abbr>$1ol$2.</abbr>");
        html = ChapRegex().Replace(html, "<abbr>$1hap.</abbr> $2");
        html = CoIncLtdStRegex().Replace(html, "<abbr>$1</abbr>");
        html = GovRegex().Replace(html, "<abbr>$1ov.</abbr>");
        html = MsAbbrevRegex().Replace(html, "<abbr>MS$1.</abbr>");
        html = VizRegex().Replace(html, "<abbr>$1iz.</abbr>");
        html = EtcRegex().Replace(html, "<abbr>etc.</abbr>");
        html = CfRegex().Replace(html, "<abbr>$1f.</abbr>");
        html = EdRegex().Replace(html, "<abbr>ed.</abbr>");
        html = VsRegex().Replace(html, "<abbr>$1s.</abbr>");
        html = FfRegex().Replace(html, "<abbr>$1f.</abbr>");
        html = LibRegex().Replace(html, "<abbr>$1ib.</abbr>");
        html = PpRegex().Replace(html, "<abbr>p$1.</abbr>$2");

        // 7. Latin abbreviations
        html = IeRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">$1.e.</abbr>");
        html = EgRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">$1.g.</abbr>");

        // 8. Month abbreviations
        html = MonthsRegex().Replace(html, "<abbr>$1</abbr>");

        // 9. No. abbreviation
        html = NoRegex().Replace(html, "<abbr>No$1.</abbr>$2");

        // 10. P.S., P.P.S.
        html = PsRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">$1</abbr>");

        // 11. Ph.D.
        html = PhdRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Ph. D.</abbr>");

        // 12. a.m./p.m.
        html = AmPmRegex().Replace(html, "<abbr>$1.m.</abbr>");
        html = TimeAmPmNumRegex().Replace(html, "$1 <abbr>$2.m.</abbr>");

        // 13. AD/BC era dates
        html = AdEraRegex().Replace(html, "<abbr epub:type=\"se:era\">AD</abbr>.$1");
        html = BcEraRegex().Replace(html, "<abbr epub:type=\"se:era\">BC</abbr>.$1");
        html = AdInlineRegex().Replace(html, "<abbr epub:type=\"se:era\">AD</abbr>");
        html = BcInlineRegex().Replace(html, "<abbr epub:type=\"se:era\">BC</abbr>");

        // 14. SI measurements: 10 cm, 5 kg, 100 ml (BEFORE roman numerals to avoid false positives)
        html = SiMeasurementsRegex().Replace(html, "$1" + Nbsp + "<abbr>$2</abbr>");

        // 15. Imperial measurements: ft, yd, mi, pt, qt, gal, oz, lb
        html = ImperialMeasurementsRegex().Replace(html, "$1" + Nbsp + "<abbr>$2.</abbr>$3");

        // 16. Inches (requires period to avoid false positives)
        html = InchesRegex().Replace(html, "$1" + Nbsp + "<abbr>in.</abbr>$2");

        // 17. Speed: mph, hp
        html = MphRegex().Replace(html, "$1" + Nbsp + "<abbr>mph</abbr>");
        html = HpRegex().Replace(html, "$1" + Nbsp + "<abbr>hp</abbr>");

        // 18. Roman numerals (2+ characters, common patterns)
        html = RomanNumeralsRegex().Replace(html, m =>
        {
            var numeral = m.Groups[1].Value;
            if (IsValidRomanNumeral(numeral))
                return "<span epub:type=\"z3998:roman\">" + numeral + "</span>";
            return m.Value;
        });

        // 19. Single lowercase 'i' as roman numeral (but not contractions)
        html = SingleIRomanRegex().Replace(html, "$1<span epub:type=\"z3998:roman\">i</span>");

        // 20. Add "eoc" class for end-of-clause abbreviations
        html = EocEtcRegex().Replace(html, "<abbr class=\"eoc\">etc.</abbr>$1");
        html = EocGeneralRegex().Replace(html, "<abbr class=\"eoc\"$1>$2</abbr>$3");

        // 21. Extended abbreviations (Jr., Sr., et al., ibid., etc.)
        html = Abbreviations.MarkupExtendedAbbreviations(html);

        return html;
    }

    /// <summary>
    /// Validate if a string is a valid Roman numeral.
    /// </summary>
    private static bool IsValidRomanNumeral(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;

        // Convert to uppercase for validation
        s = s.ToUpperInvariant();

        // Exclude common false positives
        if (s is "MI" or "DI" or "MIX" or "ID" or "LI" or "MIC" or "VIM" or "DIV" or "DIM")
            return false;

        // Check against valid roman numeral pattern
        return ValidRomanRegex().IsMatch(s);
    }

    // Initialisms
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(M\.?P\.?|H\.?M\.?S\.?|S\.?S\.?|N\.?B\.?|W\.?C\.?|I\.?O\.?U\.?)(?!\b)")]
    private static partial Regex InitialismRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(R\.?A\.?|M\.?A\.?|M\.?D\.?|K\.?C\.?|Q\.?C\.?)(?!\b)")]
    private static partial Regex InitialismTitleRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))U\.?S\.?A\.?(?!\b)")]
    private static partial Regex UsaRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([NESW]\.?[NESW]\.?)(?!\b)")]
    private static partial Regex CompassRegex();

    // Simple abbreviations
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Bros\.")]
    private static partial Regex BrosRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Mt\.")]
    private static partial Regex MtRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])ol(s?)\.")]
    private static partial Regex VolRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Cc])hap\. (\d)")]
    private static partial Regex ChapRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(Co\.|Inc\.|Ltd\.|St\.)")]
    private static partial Regex CoIncLtdStRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Gg])ov\.")]
    private static partial Regex GovRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))MS(S?)\.")]
    private static partial Regex MsAbbrevRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])iz\.")]
    private static partial Regex VizRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))etc\.")]
    private static partial Regex EtcRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Cc])f\.")]
    private static partial Regex CfRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))ed\.")]
    private static partial Regex EdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Vv])s\.")]
    private static partial Regex VsRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ff])f\.")]
    private static partial Regex FfRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ll])ib\.")]
    private static partial Regex LibRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))p(p?)\.([\s\d])")]
    private static partial Regex PpRegex();

    // Latin abbreviations
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ii])\.e\.")]
    private static partial Regex IeRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Ee])\.g\.")]
    private static partial Regex EgRegex();

    // Months
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\.)")]
    private static partial Regex MonthsRegex();

    // No.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))No(s?)\.([\s\d])")]
    private static partial Regex NoRegex();

    // P.S.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>)|\.)(P\.(?:P\.)?S\.(?:S\.)?\B)")]
    private static partial Regex PsRegex();

    // Ph.D.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Ph\.?\s*D\.?")]
    private static partial Regex PhdRegex();

    // Time
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([ap])\.\s?m\.")]
    private static partial Regex AmPmRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(\d{1,2})\s?[Aa]\.?\s?[Mm](?:\.|\b)")]
    private static partial Regex TimeAmPmNumRegex();

    // Era dates
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))A\.?D\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])")]
    private static partial Regex AdEraRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))B\.?C\.([\u201C\u201D\u2018\u2019]?</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}])")]
    private static partial Regex BcEraRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?:AD\b|A\.D\.\B)")]
    private static partial Regex AdInlineRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?:BC\b|B\.C\.\B)")]
    private static partial Regex BcInlineRegex();

    // Roman numerals
    [GeneratedRegex(@"(?<![<>/\u0022\u0027])\b(?=[CDILMVX]{2,})(?!MI\b|DI\b|MIX\b)(M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3}))\b(?![\w\u0027>-])", RegexOptions.IgnoreCase)]
    private static partial Regex RomanNumeralsRegex();

    [GeneratedRegex(@"^M{0,4}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3})$")]
    private static partial Regex ValidRomanRegex();

    [GeneratedRegex(@"([^\p{L}<>/\u0022\u0027])i\b(?![\u0027\u2011-])(?![^<>]+>)")]
    private static partial Regex SingleIRomanRegex();

    // Measurements
    [GeneratedRegex(@"(\d+)\s*([cmk][mgl])\b")]
    private static partial Regex SiMeasurementsRegex();

    [GeneratedRegex(@"(?<![\$\u00A3\d,])(\d+)\s*(ft|yd|yds|mi|pt|qt|gal|oz|lb|lbs)\.?(\W)")]
    private static partial Regex ImperialMeasurementsRegex();

    [GeneratedRegex(@"(?<![\$\u00A3\d,])(\d+)\s*in\.(\b|[\s,:;!?])")]
    private static partial Regex InchesRegex();

    [GeneratedRegex(@"(\d+)\s*m\.?p\.?h\.?", RegexOptions.IgnoreCase)]
    private static partial Regex MphRegex();

    [GeneratedRegex(@"(\d+)\s*h\.?p\.?", RegexOptions.IgnoreCase)]
    private static partial Regex HpRegex();

    // End of clause
    [GeneratedRegex(@"<abbr>etc\.</abbr>([\u201C\u201D\u2018\u2019]?(?:</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}]))")]
    private static partial Regex EocEtcRegex();

    [GeneratedRegex(@"<abbr( epub:type=\u0022[^\u0022]+\u0022)?>([^<]+\.)</abbr>([\u201C\u201D\u2018\u2019]?</p>)")]
    private static partial Regex EocGeneralRegex();
}
