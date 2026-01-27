using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Extended fraction handling with Unicode characters.
/// Ported from Standard Ebooks typography.py.
/// </summary>
public static class Fractions
{
    // Complete Unicode fraction mappings
    private static readonly Dictionary<string, string> FractionMap = new()
    {
        // Common fractions
        ["1/4"] = "\u00BC",   // ¼
        ["1/2"] = "\u00BD",   // ½
        ["3/4"] = "\u00BE",   // ¾

        // Thirds
        ["1/3"] = "\u2153",   // ⅓
        ["2/3"] = "\u2154",   // ⅔

        // Fifths
        ["1/5"] = "\u2155",   // ⅕
        ["2/5"] = "\u2156",   // ⅖
        ["3/5"] = "\u2157",   // ⅗
        ["4/5"] = "\u2158",   // ⅘

        // Sixths
        ["1/6"] = "\u2159",   // ⅙
        ["5/6"] = "\u215A",   // ⅚

        // Sevenths, eighths, ninths, tenths
        ["1/7"] = "\u2150",   // ⅐
        ["1/8"] = "\u215B",   // ⅛
        ["3/8"] = "\u215C",   // ⅜
        ["5/8"] = "\u215D",   // ⅝
        ["7/8"] = "\u215E",   // ⅞
        ["1/9"] = "\u2151",   // ⅑
        ["1/10"] = "\u2152",  // ⅒

        // Zero
        ["0/3"] = "\u2189",   // ↉
    };

    // Superscript digits for custom fractions
    private static readonly Dictionary<char, char> SuperscriptMap = new()
    {
        ['0'] = '\u2070', ['1'] = '\u00B9', ['2'] = '\u00B2', ['3'] = '\u00B3',
        ['4'] = '\u2074', ['5'] = '\u2075', ['6'] = '\u2076', ['7'] = '\u2077',
        ['8'] = '\u2078', ['9'] = '\u2079'
    };

    // Subscript digits for custom fractions
    private static readonly Dictionary<char, char> SubscriptMap = new()
    {
        ['0'] = '\u2080', ['1'] = '\u2081', ['2'] = '\u2082', ['3'] = '\u2083',
        ['4'] = '\u2084', ['5'] = '\u2085', ['6'] = '\u2086', ['7'] = '\u2087',
        ['8'] = '\u2088', ['9'] = '\u2089'
    };

    private const char FractionSlash = '\u2044'; // ⁄

    /// <summary>
    /// Convert fractions to Unicode characters or superscript/subscript format.
    /// </summary>
    public static string ConvertFractions(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Convert known fractions to Unicode
        foreach (var (fraction, unicode) in FractionMap)
        {
            var pattern = @"\b(?<!/)(" + Regex.Escape(fraction) + @")(?!/)\b";
            html = Regex.Replace(html, pattern, unicode);
        }

        // Remove space between whole number and fraction
        html = NumberFractionRegex().Replace(html, "$1$2");

        return html;
    }

    /// <summary>
    /// Convert a numeric fraction to Unicode superscript/subscript format.
    /// Returns null if conversion fails.
    /// </summary>
    public static string? NumberToFraction(int numerator, int denominator)
    {
        if (denominator == 0)
            return null;

        var key = $"{numerator}/{denominator}";
        if (FractionMap.TryGetValue(key, out var unicode))
            return unicode;

        // Build custom fraction with superscript/subscript
        var numStr = numerator.ToString();
        var denStr = denominator.ToString();

        var result = new char[numStr.Length + 1 + denStr.Length];
        var idx = 0;

        foreach (var c in numStr)
        {
            if (!SuperscriptMap.TryGetValue(c, out var sup))
                return null;
            result[idx++] = sup;
        }

        result[idx++] = FractionSlash;

        foreach (var c in denStr)
        {
            if (!SubscriptMap.TryGetValue(c, out var sub))
                return null;
            result[idx++] = sub;
        }

        return new string(result);
    }

    /// <summary>
    /// Get all supported Unicode fraction characters.
    /// </summary>
    public static IEnumerable<string> GetUnicodeFractions() => FractionMap.Values;

    // Remove space between whole number and Unicode fraction
    private static readonly Regex NumberFractionRegexInstance = new(@"(\d)\s+([\u00BC\u00BD\u00BE\u2150-\u215E\u2189])", RegexOptions.Compiled);
    private static Regex NumberFractionRegex() => NumberFractionRegexInstance;
}
