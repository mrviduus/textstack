using System.Text.RegularExpressions;

namespace TextStack.Extraction.Spelling;

/// <summary>
/// Modernizes archaic spellings to contemporary forms.
/// Ported from Standard Ebooks spelling.py.
/// Uses standard Regex instead of source-generated for ARM64 compatibility.
/// </summary>
public static class SpellingProcessor
{
    // Pre-compiled regexes for performance
    private static readonly Regex AmpersandCRegex = new(@"\b&c\.", RegexOptions.Compiled);
    private static readonly Regex ConnexionRegex = new(@"\b([Cc])onnexion(s?)\b", RegexOptions.Compiled);
    private static readonly Regex ReflexionRegex = new(@"\b([Rr])eflexion(s?)\b", RegexOptions.Compiled);
    private static readonly Regex InflexionRegex = new(@"\b([Ii])nflexion(s?)\b", RegexOptions.Compiled);
    private static readonly Regex ToDayRegex = new(@"\b([Tt])o-day\b", RegexOptions.Compiled);
    private static readonly Regex ToMorrowRegex = new(@"\b([Tt])o-morrow\b", RegexOptions.Compiled);
    private static readonly Regex ToNightRegex = new(@"\b([Tt])o-night\b", RegexOptions.Compiled);
    private static readonly Regex NowadaysRegex = new(@"\b([Nn])ow-a-days\b", RegexOptions.Compiled);
    private static readonly Regex AnyOneRegex = new(@"\b([Aa])ny-one\b", RegexOptions.Compiled);
    private static readonly Regex EveryOneRegex = new(@"\b([Ee])very-one\b", RegexOptions.Compiled);
    private static readonly Regex SomeOneRegex = new(@"\b([Ss])ome-one\b", RegexOptions.Compiled);
    private static readonly Regex NoOneRegex = new(@"\b([Nn])o-one\b", RegexOptions.Compiled);
    private static readonly Regex AnyThingRegex = new(@"\b([Aa])ny-thing\b", RegexOptions.Compiled);
    private static readonly Regex EveryThingRegex = new(@"\b([Ee])very-thing\b", RegexOptions.Compiled);
    private static readonly Regex SomeThingRegex = new(@"\b([Ss])ome-thing\b", RegexOptions.Compiled);
    private static readonly Regex AnyWhereRegex = new(@"\b([Aa])ny-where\b", RegexOptions.Compiled);
    private static readonly Regex EveryWhereRegex = new(@"\b([Ee])very-where\b", RegexOptions.Compiled);
    private static readonly Regex SomeWhereRegex = new(@"\b([Ss])ome-where\b", RegexOptions.Compiled);
    private static readonly Regex NoWhereRegex = new(@"\b([Nn])o-where\b", RegexOptions.Compiled);
    private static readonly Regex MeanWhileRegex = new(@"\b([Mm])ean-while\b", RegexOptions.Compiled);
    private static readonly Regex ShewRegex = new(@"\b([Ss])hew(n|ed|ing|s)?\b", RegexOptions.Compiled);
    private static readonly Regex GaolRegex = new(@"\b([Gg])aol(er|s|ed)?\b", RegexOptions.Compiled);
    private static readonly Regex DespatchRegex = new(@"\b([Dd])espatch(es|ed|ing)?\b", RegexOptions.Compiled);
    private static readonly Regex BehoveRegex = new(@"\b([Bb])ehove(s|d)?\b", RegexOptions.Compiled);
    private static readonly Regex WaggonRegex = new(@"\b([Ww])aggon(s|er|ers)?\b", RegexOptions.Compiled);
    private static readonly Regex ClewRegex = new(@"\b([Cc])lew(s|ed)?\b", RegexOptions.Compiled);
    private static readonly Regex BurthenRegex = new(@"\b([Bb])urthen(s|ed|ing|some)?\b", RegexOptions.Compiled);
    private static readonly Regex HindooRegex = new(@"\b([Hh])indoo(s|ism)?\b", RegexOptions.Compiled);
    private static readonly Regex IntrustRegex = new(@"\b([Ii])ntrust(s|ed|ing)?\b", RegexOptions.Compiled);
    private static readonly Regex DulnessRegex = new(@"\b([Dd])ulness\b", RegexOptions.Compiled);
    private static readonly Regex SkilfulRegex = new(@"\b([Ss])kilful(ly)?\b", RegexOptions.Compiled);
    private static readonly Regex WilfulRegex = new(@"\b([Ww])ilful(ly|ness)?\b", RegexOptions.Compiled);
    private static readonly Regex FulfilRegex = new(@"\b([Ff])ulfil(s|led|ling|ment)?\b", RegexOptions.Compiled);
    private static readonly Regex InstalmentRegex = new(@"\b([Ii])nstalment(s)?\b", RegexOptions.Compiled);

    /// <summary>
    /// Modernize archaic spellings to contemporary English.
    /// </summary>
    public static string ModernizeSpelling(string html, string? language = null)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Default to English
        language ??= "en";

        // Only process English text
        if (!language.StartsWith("en", StringComparison.OrdinalIgnoreCase))
            return html;

        // &c. → etc.
        html = AmpersandCRegex.Replace(html, "etc.");

        // connexion → connection (but not complexion)
        html = ConnexionRegex.Replace(html, "$1onnection$2");

        // reflexion → reflection (but not complexion)
        html = ReflexionRegex.Replace(html, "$1eflection$2");

        // inflexion → inflection
        html = InflexionRegex.Replace(html, "$1nflection$2");

        // to-day → today
        html = ToDayRegex.Replace(html, "$1oday");

        // to-morrow → tomorrow
        html = ToMorrowRegex.Replace(html, "$1omorrow");

        // to-night → tonight
        html = ToNightRegex.Replace(html, "$1onight");

        // now-a-days → nowadays
        html = NowadaysRegex.Replace(html, "$1owadays");

        // any-one → anyone
        html = AnyOneRegex.Replace(html, "$1nyone");

        // every-one → everyone
        html = EveryOneRegex.Replace(html, "$1veryone");

        // some-one → someone
        html = SomeOneRegex.Replace(html, "$1omeone");

        // no-one → no one (note: not "noone")
        html = NoOneRegex.Replace(html, "$1o one");

        // any-thing → anything
        html = AnyThingRegex.Replace(html, "$1nything");

        // every-thing → everything
        html = EveryThingRegex.Replace(html, "$1verything");

        // some-thing → something
        html = SomeThingRegex.Replace(html, "$1omething");

        // any-where → anywhere
        html = AnyWhereRegex.Replace(html, "$1nywhere");

        // every-where → everywhere
        html = EveryWhereRegex.Replace(html, "$1verywhere");

        // some-where → somewhere
        html = SomeWhereRegex.Replace(html, "$1omewhere");

        // no-where → nowhere
        html = NoWhereRegex.Replace(html, "$1owhere");

        // mean-while → meanwhile
        html = MeanWhileRegex.Replace(html, "$1eanwhile");

        // shew/shewn → show/shown
        html = ShewRegex.Replace(html, "$1how$2");

        // gaol → jail
        html = GaolRegex.Replace(html, "$1ail$2");

        // despatch → dispatch
        html = DespatchRegex.Replace(html, "$1ispatch$2");

        // behove → behoove (US)
        html = BehoveRegex.Replace(html, "$1ehoove$2");

        // waggon → wagon
        html = WaggonRegex.Replace(html, "$1agon$2");

        // clew → clue
        html = ClewRegex.Replace(html, "$1lue$2");

        // burthen → burden
        html = BurthenRegex.Replace(html, "$1urden$2");

        // Hindoo → Hindu
        html = HindooRegex.Replace(html, "$1indu$2");

        // intrust → entrust
        html = IntrustRegex.Replace(html, "$1ntrust$2");

        // dulness → dullness
        html = DulnessRegex.Replace(html, "$1ullness$2");

        // skilful → skillful (US)
        html = SkilfulRegex.Replace(html, "$1killful$2");

        // wilful → willful (US)
        html = WilfulRegex.Replace(html, "$1illful$2");

        // fulfil → fulfill (US)
        html = FulfilRegex.Replace(html, "$1ulfill$2");

        // instalment → installment (US)
        html = InstalmentRegex.Replace(html, "$1nstallment$2");

        return html;
    }
}
