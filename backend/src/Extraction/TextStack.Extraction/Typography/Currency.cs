using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Historical currency normalization.
/// Ported from Standard Ebooks typography.py.
/// </summary>
public static partial class Currency
{
    /// <summary>
    /// Normalize historical currency formats.
    /// L → £, shillings/pence formatting.
    /// </summary>
    public static string NormalizeCurrency(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // L to £ (British pounds): L50 → £50
        // Must be followed by number or fraction
        html = LToPoundRegex().Replace(html, "\u00A3$1");

        // Old-style pounds/shillings/pence: £1. 5s. 3d.
        // Normalize spacing
        html = PsdSpacingRegex().Replace(html, "$1$2$3");

        return html;
    }

    // L followed by number/fraction → £
    // Matches: L50, L1000, L½, L¼
    [GeneratedRegex(@"\bL([0-9\u00BD\u00BC\u00BE\u2153\u2154\u2155\u2156\u2157\u2158\u2159\u215A\u215B\u215C\u215D\u215E]+)")]
    private static partial Regex LToPoundRegex();

    // Normalize £/s./d. spacing
    [GeneratedRegex(@"(\u00A3[0-9]+)\.\s*([0-9]+s\.)\s*([0-9]+d\.)")]
    private static partial Regex PsdSpacingRegex();
}
