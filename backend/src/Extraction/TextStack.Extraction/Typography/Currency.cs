using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Historical currency normalization.
/// Ported from Standard Ebooks typography.py.
/// </summary>
public static partial class Currency
{
    private const char Nbsp = '\u00a0';

    /// <summary>
    /// Normalize historical currency formats.
    /// L → £, shillings/pence formatting, guinea notation.
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

        // Standalone shillings: 5s. → 5s.
        // Add non-breaking space between number and s.
        html = ShillingsRegex().Replace(html, $"$1{Nbsp}s.");

        // Standalone pence: 3d. → 3d.
        // Add non-breaking space between number and d.
        html = PenceRegex().Replace(html, $"$1{Nbsp}d.");

        // Combined shillings and pence: 5s. 3d.
        // Normalize to: 5s.\u00a03d.
        html = ShillingsPenceRegex().Replace(html, $"$1s.{Nbsp}$2d.");

        // Guinea notation: gns. or gs.
        html = GuineasRegex().Replace(html, $"$1{Nbsp}gns.");

        // Florin (2 shillings): 2/- or 2s.
        html = FlorinRegex().Replace(html, "$1/-");

        return html;
    }

    // L followed by number/fraction → £
    // Matches: L50, L1000, L½, L¼
    [GeneratedRegex(@"\bL([0-9\u00BD\u00BC\u00BE\u2153\u2154\u2155\u2156\u2157\u2158\u2159\u215A\u215B\u215C\u215D\u215E]+)")]
    private static partial Regex LToPoundRegex();

    // Normalize £/s./d. spacing
    [GeneratedRegex(@"(\u00A3[0-9]+)\.\s*([0-9]+s\.)\s*([0-9]+d\.)")]
    private static partial Regex PsdSpacingRegex();

    // Standalone shillings: 5s. (but not part of £ notation)
    [GeneratedRegex(@"(?<!\u00A3\d*\s*)(?<![0-9])(\d+)\s*s\.(?!\s*\d+d)")]
    private static partial Regex ShillingsRegex();

    // Standalone pence: 3d.
    [GeneratedRegex(@"(?<![0-9]s\.\s*)(?<![0-9])(\d+)\s*d\.")]
    private static partial Regex PenceRegex();

    // Combined shillings and pence: 5s. 3d.
    [GeneratedRegex(@"(\d+)\s*s\.\s*(\d+)\s*d\.")]
    private static partial Regex ShillingsPenceRegex();

    // Guinea notation: 5 gns. or 5 gs.
    [GeneratedRegex(@"(\d+)\s*g(?:n)?s\.")]
    private static partial Regex GuineasRegex();

    // Florin: 2/- pattern
    [GeneratedRegex(@"(\d+)\s*/\s*-")]
    private static partial Regex FlorinRegex();
}
