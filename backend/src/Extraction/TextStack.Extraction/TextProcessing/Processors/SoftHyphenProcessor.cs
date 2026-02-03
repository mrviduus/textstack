using System.Reflection;
using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Inserts soft hyphens (U+00AD) at syllable breaks for improved line breaking.
/// Uses dictionary-based hyphenation patterns.
/// </summary>
public class SoftHyphenProcessor : ITextProcessor
{
    public string Name => "SoftHyphen";
    public int Order => 800; // Run late, after other text processing

    private const char SoftHyphen = '\u00AD';
    private const int MinWordLength = 8;
    private const int MinFragmentLength = 3;

    private static readonly Lazy<Dictionary<string, string>> HyphenationDict = new(LoadHyphenationDictionary);
    private static readonly Regex WordRegex = new(@"\b([a-zA-Z]{8,})\b", RegexOptions.Compiled);

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        // Only process English text
        if (!context.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase))
            return input;

        return WordRegex.Replace(input, match =>
        {
            var word = match.Value;

            // Don't process words inside HTML tags
            if (IsLikelyInTag(input, match.Index))
                return word;

            var hyphenated = HyphenateWord(word);
            return hyphenated;
        });
    }

    private static bool IsLikelyInTag(string html, int index)
    {
        // Quick check: look for < before and > after within reasonable distance
        var start = Math.Max(0, index - 50);
        var segment = html.Substring(start, Math.Min(100, html.Length - start));
        var localIndex = index - start;

        var lastOpen = segment.LastIndexOf('<', Math.Min(localIndex, segment.Length - 1));
        var lastClose = segment.LastIndexOf('>', Math.Min(localIndex, segment.Length - 1));

        return lastOpen > lastClose;
    }

    private static string HyphenateWord(string word)
    {
        var lowerWord = word.ToLowerInvariant();

        // Check dictionary first
        if (HyphenationDict.Value.TryGetValue(lowerWord, out var hyphenated))
        {
            return ApplyHyphenationPattern(word, hyphenated);
        }

        // Apply algorithmic hyphenation for unknown words
        return ApplyAlgorithmicHyphenation(word);
    }

    private static string ApplyHyphenationPattern(string original, string pattern)
    {
        // Pattern uses hyphens to show breaks: "ex-am-ple"
        // Apply same breaks to original word preserving case
        var result = new System.Text.StringBuilder();
        var patternParts = pattern.Split('-');
        var originalIndex = 0;

        for (var i = 0; i < patternParts.Length; i++)
        {
            var part = patternParts[i];

            // Copy corresponding characters from original
            for (var j = 0; j < part.Length && originalIndex < original.Length; j++)
            {
                result.Append(original[originalIndex++]);
            }

            // Add soft hyphen between parts (but not after last part)
            if (i < patternParts.Length - 1)
            {
                result.Append(SoftHyphen);
            }
        }

        return result.ToString();
    }

    private static string ApplyAlgorithmicHyphenation(string word)
    {
        if (word.Length < MinWordLength)
            return word;

        var result = new System.Text.StringBuilder();
        var vowels = new HashSet<char> { 'a', 'e', 'i', 'o', 'u', 'y' };
        var lastBreak = 0;

        for (var i = 1; i < word.Length - MinFragmentLength; i++)
        {
            // Basic rule: break after vowel followed by consonant
            var prevChar = char.ToLowerInvariant(word[i - 1]);
            var currChar = char.ToLowerInvariant(word[i]);

            if (vowels.Contains(prevChar) && !vowels.Contains(currChar))
            {
                // Check minimum fragment length
                if (i - lastBreak >= MinFragmentLength && word.Length - i >= MinFragmentLength)
                {
                    result.Append(word.AsSpan(lastBreak, i - lastBreak));
                    result.Append(SoftHyphen);
                    lastBreak = i;
                }
            }
        }

        // Append remaining part
        result.Append(word.AsSpan(lastBreak));

        return result.ToString();
    }

    private static Dictionary<string, string> LoadHyphenationDictionary()
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = "TextStack.Extraction.TextProcessing.Data.hyphenation-en.txt";

            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null)
                return GetBuiltInHyphenation();

            using var reader = new StreamReader(stream);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var trimmed = line.Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#'))
                    continue;

                // Format: "hyphenated-word" (hyphenation points marked with -)
                var normalized = trimmed.Replace("-", "");
                if (normalized.Length >= MinWordLength)
                {
                    dict[normalized] = trimmed;
                }
            }
        }
        catch
        {
            return GetBuiltInHyphenation();
        }

        return dict;
    }

    private static Dictionary<string, string> GetBuiltInHyphenation()
    {
        // Common words with known hyphenation patterns
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            // Common long words
            ["absolutely"] = "ab-so-lute-ly",
            ["according"] = "ac-cord-ing",
            ["acknowledge"] = "ac-knowl-edge",
            ["adventure"] = "ad-ven-ture",
            ["afternoon"] = "af-ter-noon",
            ["afterward"] = "af-ter-ward",
            ["agreement"] = "a-gree-ment",
            ["altogether"] = "al-to-geth-er",
            ["ambassador"] = "am-bas-sa-dor",
            ["america"] = "A-mer-i-ca",
            ["american"] = "A-mer-i-can",
            ["apparently"] = "ap-par-ent-ly",
            ["appearance"] = "ap-pear-ance",
            ["application"] = "ap-pli-ca-tion",
            ["attention"] = "at-ten-tion",
            ["beautiful"] = "beau-ti-ful",
            ["beginning"] = "be-gin-ning",
            ["believe"] = "be-lieve",
            ["between"] = "be-tween",
            ["business"] = "busi-ness",
            ["character"] = "char-ac-ter",
            ["children"] = "chil-dren",
            ["circumstances"] = "cir-cum-stances",
            ["comfortable"] = "com-fort-able",
            ["companion"] = "com-pan-ion",
            ["company"] = "com-pa-ny",
            ["complete"] = "com-plete",
            ["completely"] = "com-plete-ly",
            ["condition"] = "con-di-tion",
            ["consciousness"] = "con-scious-ness",
            ["considerable"] = "con-sid-er-able",
            ["consideration"] = "con-sid-er-a-tion",
            ["continued"] = "con-tin-ued",
            ["conversation"] = "con-ver-sa-tion",
            ["countenance"] = "coun-te-nance",
            ["country"] = "coun-try",
            ["daughter"] = "daugh-ter",
            ["delighted"] = "de-light-ed",
            ["description"] = "de-scrip-tion",
            ["determined"] = "de-ter-mined",
            ["different"] = "dif-fer-ent",
            ["direction"] = "di-rec-tion",
            ["disappointment"] = "dis-ap-point-ment",
            ["discovered"] = "dis-cov-ered",
            ["distance"] = "dis-tance",
            ["distinguished"] = "dis-tin-guished",
            ["everything"] = "ev-ery-thing",
            ["evidently"] = "ev-i-dent-ly",
            ["examination"] = "ex-am-i-na-tion",
            ["excellent"] = "ex-cel-lent",
            ["excitement"] = "ex-cite-ment",
            ["exclaimed"] = "ex-claimed",
            ["experience"] = "ex-pe-ri-ence",
            ["expression"] = "ex-pres-sion",
            ["extraordinary"] = "ex-tra-or-di-nary",
            ["extremely"] = "ex-treme-ly",
            ["familiar"] = "fa-mil-iar",
            ["fashionable"] = "fash-ion-able",
            ["following"] = "fol-low-ing",
            ["forgotten"] = "for-got-ten",
            ["fortunate"] = "for-tu-nate",
            ["fortunately"] = "for-tu-nate-ly",
            ["friendship"] = "friend-ship",
            ["generally"] = "gen-er-al-ly",
            ["gentleman"] = "gen-tle-man",
            ["government"] = "gov-ern-ment",
            ["happiness"] = "hap-pi-ness",
            ["happening"] = "hap-pen-ing",
            ["immediately"] = "im-me-di-ate-ly",
            ["importance"] = "im-por-tance",
            ["important"] = "im-por-tant",
            ["impossible"] = "im-pos-si-ble",
            ["impression"] = "im-pres-sion",
            ["independence"] = "in-de-pen-dence",
            ["independent"] = "in-de-pen-dent",
            ["information"] = "in-for-ma-tion",
            ["intelligence"] = "in-tel-li-gence",
            ["interesting"] = "in-ter-est-ing",
            ["introduction"] = "in-tro-duc-tion",
            ["knowledge"] = "knowl-edge",
            ["lieutenant"] = "lieu-ten-ant",
            ["magnificent"] = "mag-nif-i-cent",
            ["management"] = "man-age-ment",
            ["manufacture"] = "man-u-fac-ture",
            ["miserable"] = "mis-er-able",
            ["mysterious"] = "mys-te-ri-ous",
            ["naturally"] = "nat-u-ral-ly",
            ["necessary"] = "nec-es-sary",
            ["neighborhood"] = "neigh-bor-hood",
            ["nevertheless"] = "nev-er-the-less",
            ["observation"] = "ob-ser-va-tion",
            ["opportunity"] = "op-por-tu-ni-ty",
            ["otherwise"] = "oth-er-wise",
            ["particular"] = "par-tic-u-lar",
            ["particularly"] = "par-tic-u-lar-ly",
            ["perfectly"] = "per-fect-ly",
            ["performance"] = "per-for-mance",
            ["permission"] = "per-mis-sion",
            ["physician"] = "phy-si-cian",
            ["pleasure"] = "plea-sure",
            ["possession"] = "pos-ses-sion",
            ["possible"] = "pos-si-ble",
            ["presence"] = "pres-ence",
            ["president"] = "pres-i-dent",
            ["principal"] = "prin-ci-pal",
            ["probably"] = "prob-a-bly",
            ["professor"] = "pro-fes-sor",
            ["proposition"] = "prop-o-si-tion",
            ["protection"] = "pro-tec-tion",
            ["question"] = "ques-tion",
            ["reasonable"] = "rea-son-able",
            ["recognized"] = "rec-og-nized",
            ["remarkable"] = "re-mark-able",
            ["remembered"] = "re-mem-bered",
            ["representation"] = "rep-re-sen-ta-tion",
            ["resolution"] = "res-o-lu-tion",
            ["responsibility"] = "re-spon-si-bil-i-ty",
            ["restaurant"] = "res-tau-rant",
            ["satisfaction"] = "sat-is-fac-tion",
            ["secretary"] = "sec-re-tary",
            ["sensation"] = "sen-sa-tion",
            ["sentiment"] = "sen-ti-ment",
            ["situation"] = "sit-u-a-tion",
            ["something"] = "some-thing",
            ["sometimes"] = "some-times",
            ["somewhere"] = "some-where",
            ["statement"] = "state-ment",
            ["stranger"] = "stran-ger",
            ["strength"] = "strength",
            ["struggle"] = "strug-gle",
            ["successful"] = "suc-cess-ful",
            ["sufficient"] = "suf-fi-cient",
            ["suggestion"] = "sug-ges-tion",
            ["surprise"] = "sur-prise",
            ["surprised"] = "sur-prised",
            ["surrounded"] = "sur-round-ed",
            ["terrible"] = "ter-ri-ble",
            ["themselves"] = "them-selves",
            ["therefore"] = "there-fore",
            ["throughout"] = "through-out",
            ["together"] = "to-geth-er",
            ["tomorrow"] = "to-mor-row",
            ["understanding"] = "un-der-stand-ing",
            ["unfortunate"] = "un-for-tu-nate",
            ["unfortunately"] = "un-for-tu-nate-ly",
            ["university"] = "u-ni-ver-si-ty",
            ["whatever"] = "what-ev-er",
            ["whenever"] = "when-ev-er",
            ["wherever"] = "wher-ev-er",
            ["whichever"] = "which-ev-er",
            ["wonderful"] = "won-der-ful",
            ["yesterday"] = "yes-ter-day",
        };
    }
}
