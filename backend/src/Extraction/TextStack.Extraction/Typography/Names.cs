using System.Text.RegularExpressions;

namespace TextStack.Extraction.Typography;

/// <summary>
/// Handles Scottish/Irish name typography.
/// M'Gregor → McGregor, etc.
/// </summary>
public static partial class Names
{
    /// <summary>
    /// Normalize Scottish/Irish name prefixes.
    /// M'Gregor → McGregor, M'Donald → McDonald
    /// </summary>
    public static string NormalizeNames(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // M'Name → McName (Scottish/Irish patronymic)
        html = ScottishMcRegex().Replace(html, "Mc$1");

        // O'Name should use proper apostrophe
        html = IrishORegex().Replace(html, "O\u2019$1");

        return html;
    }

    // M'Name pattern: M followed by apostrophe/quote and capital letter
    [GeneratedRegex(@"M['\u2018\u2019]([A-Z][a-z]+)")]
    private static partial Regex ScottishMcRegex();

    // O'Name pattern: ensure proper apostrophe
    [GeneratedRegex(@"O['\u2018]([A-Z][a-z]+)")]
    private static partial Regex IrishORegex();
}
