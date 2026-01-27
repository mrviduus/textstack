using System.Text.RegularExpressions;

namespace TextStack.Extraction.Semantic;

/// <summary>
/// Extended abbreviation handling.
/// Supplements SemanticProcessor with additional abbreviation patterns.
/// </summary>
public static partial class Abbreviations
{
    private const char Nbsp = '\u00a0';

    /// <summary>
    /// Mark up extended abbreviations not covered by SemanticProcessor.
    /// </summary>
    public static string MarkupExtendedAbbreviations(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Jr./Sr. (Junior/Senior) - name titles
        html = JrSrRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">$1r.</abbr>");

        // Extended compass directions: NNE, NNW, SSE, SSW, ENE, ESE, WNW, WSW
        html = ExtendedCompassRegex().Replace(html, m =>
        {
            var dir = m.Groups[1].Value.Replace(".", "");
            var formatted = string.Join(".", dir.ToCharArray()) + ".";
            return "<abbr epub:type=\"se:compass\">" + formatted + "</abbr>";
        });

        // et al. (et alii)
        html = EtAlRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">et al.</abbr>");

        // ibid. (ibidem)
        html = IbidRegex().Replace(html, "<abbr>ibid.</abbr>");

        // op. cit. (opere citato)
        html = OpCitRegex().Replace(html, "<abbr>op. cit.</abbr>");

        // loc. cit. (loco citato)
        html = LocCitRegex().Replace(html, "<abbr>loc. cit.</abbr>");

        // ca./c. (circa) - date approximation
        html = CircaRegex().Replace(html, "<abbr>$1.</abbr>$2");

        // fl. (floruit) - flourished
        html = FloruitRegex().Replace(html, "<abbr>fl.</abbr>$1");

        // sc. (scilicet)
        html = ScilicetRegex().Replace(html, "<abbr>sc.</abbr>");

        // sic
        html = SicRegex().Replace(html, "<abbr>sic</abbr>");

        // q.v. (quod vide)
        html = QvRegex().Replace(html, "<abbr>q.v.</abbr>");

        // N.B. (nota bene) - if not already marked
        html = NbRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">N.B.</abbr>");

        // Messrs. (messieurs) - if not already marked
        html = MessrsRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Messrs.</abbr>");

        // Assn./Assoc. (Association)
        html = AssnRegex().Replace(html, "<abbr>$1ss$2.</abbr>");

        // Dept. (Department)
        html = DeptRegex().Replace(html, "<abbr>Dept.</abbr>");

        // Univ. (University)
        html = UnivRegex().Replace(html, "<abbr>Univ.</abbr>");

        // approx. (approximately)
        html = ApproxRegex().Replace(html, "<abbr>approx.</abbr>");

        // misc. (miscellaneous)
        html = MiscRegex().Replace(html, "<abbr>misc.</abbr>");

        return html;
    }

    /// <summary>
    /// Add "eoc" class to abbreviations at end of sentences.
    /// </summary>
    public static string MarkEndOfClause(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Add eoc class to abbreviations followed by sentence-ending punctuation
        html = EocAbbrRegex().Replace(html, "<abbr class=\"eoc\"$1>$2</abbr>$3");

        return html;
    }

    // Jr./Sr.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([JS])r\.")]
    private static partial Regex JrSrRegex();

    // Extended compass: NNE, NNW, SSE, SSW, ENE, ESE, WNW, WSW
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([NS][NS][EW]|[EW][NS][EW])\.?(?!\b)")]
    private static partial Regex ExtendedCompassRegex();

    // et al.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))et\s+al\.")]
    private static partial Regex EtAlRegex();

    // ibid.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))[Ii]bid\.")]
    private static partial Regex IbidRegex();

    // op. cit.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))op\.\s*cit\.")]
    private static partial Regex OpCitRegex();

    // loc. cit.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))loc\.\s*cit\.")]
    private static partial Regex LocCitRegex();

    // ca./c. (circa) followed by date
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Cc]a?)\.(\s*\d)")]
    private static partial Regex CircaRegex();

    // fl. (floruit)
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))fl\.(\s*\d)")]
    private static partial Regex FloruitRegex();

    // sc. (scilicet)
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))sc\.")]
    private static partial Regex ScilicetRegex();

    // sic (usually in brackets)
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))\[sic\]")]
    private static partial Regex SicRegex();

    // q.v.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))q\.v\.")]
    private static partial Regex QvRegex();

    // N.B.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))N\.B\.")]
    private static partial Regex NbRegex();

    // Messrs.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Messrs\.")]
    private static partial Regex MessrsRegex();

    // Assn./Assoc.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))([Aa])ss(n|oc)\.")]
    private static partial Regex AssnRegex();

    // Dept.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Dept\.")]
    private static partial Regex DeptRegex();

    // Univ.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Univ\.")]
    private static partial Regex UnivRegex();

    // approx.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))approx\.")]
    private static partial Regex ApproxRegex();

    // misc.
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))misc\.")]
    private static partial Regex MiscRegex();

    // End of clause: abbr followed by period and closing tag or capital
    [GeneratedRegex(@"<abbr( epub:type=\""[^\""]+\"")?>((?:(?!</abbr>).)+)</abbr>([\u201C\u201D\u2018\u2019]?(?:</p>|\s+[\u201C\u201D\u2018\u2019]?[\p{Lu}]))")]
    private static partial Regex EocAbbrRegex();
}
