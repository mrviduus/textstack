using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Modernizes archaic spellings to contemporary forms.
/// </summary>
public class SpellingProcessor : ITextProcessor
{
    public string Name => "Spelling";
    public int Order => 400;

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

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        // Only process English text
        if (!context.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase))
            return input;

        var html = input;

        html = AmpersandCRegex.Replace(html, "etc.");
        html = ConnexionRegex.Replace(html, "$1onnection$2");
        html = ReflexionRegex.Replace(html, "$1eflection$2");
        html = InflexionRegex.Replace(html, "$1nflection$2");
        html = ToDayRegex.Replace(html, "$1oday");
        html = ToMorrowRegex.Replace(html, "$1omorrow");
        html = ToNightRegex.Replace(html, "$1onight");
        html = NowadaysRegex.Replace(html, "$1owadays");
        html = AnyOneRegex.Replace(html, "$1nyone");
        html = EveryOneRegex.Replace(html, "$1veryone");
        html = SomeOneRegex.Replace(html, "$1omeone");
        html = NoOneRegex.Replace(html, "$1o one");
        html = AnyThingRegex.Replace(html, "$1nything");
        html = EveryThingRegex.Replace(html, "$1verything");
        html = SomeThingRegex.Replace(html, "$1omething");
        html = AnyWhereRegex.Replace(html, "$1nywhere");
        html = EveryWhereRegex.Replace(html, "$1verywhere");
        html = SomeWhereRegex.Replace(html, "$1omewhere");
        html = NoWhereRegex.Replace(html, "$1owhere");
        html = MeanWhileRegex.Replace(html, "$1eanwhile");
        html = ShewRegex.Replace(html, "$1how$2");
        html = GaolRegex.Replace(html, "$1ail$2");
        html = DespatchRegex.Replace(html, "$1ispatch$2");
        html = BehoveRegex.Replace(html, "$1ehoove$2");
        html = WaggonRegex.Replace(html, "$1agon$2");
        html = ClewRegex.Replace(html, "$1lue$2");
        html = BurthenRegex.Replace(html, "$1urden$2");
        html = HindooRegex.Replace(html, "$1indu$2");
        html = IntrustRegex.Replace(html, "$1ntrust$2");
        html = DulnessRegex.Replace(html, "$1ullness$2");
        html = SkilfulRegex.Replace(html, "$1killful$2");
        html = WilfulRegex.Replace(html, "$1illful$2");
        html = FulfilRegex.Replace(html, "$1ulfill$2");
        html = InstalmentRegex.Replace(html, "$1nstallment$2");

        return html;
    }
}
