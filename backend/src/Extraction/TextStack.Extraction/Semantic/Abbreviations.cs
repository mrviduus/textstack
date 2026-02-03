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

        // Military ranks
        html = SgtRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Sgt.</abbr>");
        html = CplRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Cpl.</abbr>");
        html = MajRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Maj.</abbr>");
        html = GenRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Gen.</abbr>");
        html = AdmRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Adm.</abbr>");
        html = CmdrRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Cmdr.</abbr>");
        html = ColRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Col.</abbr>");
        html = BrigRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Brig.</abbr>");
        html = CdreRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Cdre.</abbr>");

        // Academic degrees
        html = BaRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">B.A.</abbr>");
        html = BsRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">B.S.</abbr>");
        html = MaRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">M.A.</abbr>");
        html = MsRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">M.S.</abbr>");
        html = DdRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">D.D.</abbr>");
        html = LldRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">LL.D.</abbr>");
        html = PhdRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">Ph.D.</abbr>");
        html = MdRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">M.D.</abbr>");

        // Religious titles
        html = RtRevRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Rt. Rev.</abbr>");
        html = VeryRevRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Very Rev.</abbr>");
        html = RevRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Rev.</abbr>");

        // Legal titles
        html = AttyRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Atty.</abbr>");
        html = JpRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">J.P.</abbr>");
        html = KcRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">K.C.</abbr>");
        html = QcRegex().Replace(html, "<abbr epub:type=\"z3998:name-title\">Q.C.</abbr>");

        // Time periods
        html = BceRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">BCE</abbr>");
        html = CeRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">CE</abbr>");
        html = AhRegex().Replace(html, "<abbr epub:type=\"z3998:initialism\">AH</abbr>");

        // Units and measures
        html = FtRegex().Replace(html, "<abbr>ft.</abbr>");
        html = InRegex().Replace(html, "<abbr>in.</abbr>");
        html = YdRegex().Replace(html, "<abbr>yd.</abbr>");
        html = MiRegex().Replace(html, "<abbr>mi.</abbr>");
        html = OzRegex().Replace(html, "<abbr>oz.</abbr>");
        html = LbRegex().Replace(html, "<abbr>lb.</abbr>");
        html = LbsRegex().Replace(html, "<abbr>lbs.</abbr>");
        html = GalRegex().Replace(html, "<abbr>gal.</abbr>");
        html = QtRegex().Replace(html, "<abbr>qt.</abbr>");
        html = PtRegex().Replace(html, "<abbr>pt.</abbr>");

        // Other common abbreviations
        html = VsRegex().Replace(html, "<abbr>vs.</abbr>");
        html = IncRegex().Replace(html, "<abbr>Inc.</abbr>");
        html = LtdRegex().Replace(html, "<abbr>Ltd.</abbr>");
        html = CorpRegex().Replace(html, "<abbr>Corp.</abbr>");
        html = CoRegex().Replace(html, "<abbr>Co.</abbr>");
        html = BrosRegex().Replace(html, "<abbr>Bros.</abbr>");
        html = PlRegex().Replace(html, "<abbr>Pl.</abbr>");
        html = AveRegex().Replace(html, "<abbr>Ave.</abbr>");
        html = BlvdRegex().Replace(html, "<abbr>Blvd.</abbr>");
        html = RdRegex().Replace(html, "<abbr>Rd.</abbr>");

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

    // Military ranks
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Sgt\.")]
    private static partial Regex SgtRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Cpl\.")]
    private static partial Regex CplRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Maj\.")]
    private static partial Regex MajRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Gen\.")]
    private static partial Regex GenRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Adm\.")]
    private static partial Regex AdmRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Cmdr\.")]
    private static partial Regex CmdrRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Col\.")]
    private static partial Regex ColRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Brig\.")]
    private static partial Regex BrigRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Cdre\.")]
    private static partial Regex CdreRegex();

    // Academic degrees
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))B\.A\.")]
    private static partial Regex BaRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))B\.S\.")]
    private static partial Regex BsRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))M\.A\.")]
    private static partial Regex MaRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))M\.S\.")]
    private static partial Regex MsRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))D\.D\.")]
    private static partial Regex DdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))LL\.D\.")]
    private static partial Regex LldRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Ph\.D\.")]
    private static partial Regex PhdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))M\.D\.")]
    private static partial Regex MdRegex();

    // Religious titles
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Rt\.\s*Rev\.")]
    private static partial Regex RtRevRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Very\s+Rev\.")]
    private static partial Regex VeryRevRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Rev\.")]
    private static partial Regex RevRegex();

    // Legal titles
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Atty\.")]
    private static partial Regex AttyRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))J\.P\.")]
    private static partial Regex JpRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))K\.C\.")]
    private static partial Regex KcRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Q\.C\.")]
    private static partial Regex QcRegex();

    // Time periods
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))B\.?C\.?E\.?(?=[\s,;:.\)])")]
    private static partial Regex BceRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<!B)C\.?E\.?(?=[\s,;:.\)])")]
    private static partial Regex CeRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))A\.?H\.?(?=[\s,;:.\d])")]
    private static partial Regex AhRegex();

    // Units and measures
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)ft\.")]
    private static partial Regex FtRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)in\.")]
    private static partial Regex InRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)yd\.")]
    private static partial Regex YdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)mi\.")]
    private static partial Regex MiRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)oz\.")]
    private static partial Regex OzRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)lb\.(?!s)")]
    private static partial Regex LbRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)lbs\.")]
    private static partial Regex LbsRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)gal\.")]
    private static partial Regex GalRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)qt\.")]
    private static partial Regex QtRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))(?<=\d\s*)pt\.")]
    private static partial Regex PtRegex();

    // Other common abbreviations
    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))vs\.")]
    private static partial Regex VsRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Inc\.")]
    private static partial Regex IncRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Ltd\.")]
    private static partial Regex LtdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Corp\.")]
    private static partial Regex CorpRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Co\.")]
    private static partial Regex CoRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Bros\.")]
    private static partial Regex BrosRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Pl\.")]
    private static partial Regex PlRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Ave\.")]
    private static partial Regex AveRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Blvd\.")]
    private static partial Regex BlvdRegex();

    [GeneratedRegex(@"(?<!(?:\.|\B|<abbr[^>]*?>))Rd\.")]
    private static partial Regex RdRegex();
}
