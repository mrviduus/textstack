using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TextStack.Search.Analyzers;

public static partial class TextNormalizer
{
    /// <summary>
    /// Normalizes text: lowercase, collapse whitespace, trim.
    /// </summary>
    public static string Normalize(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        var result = text.ToLowerInvariant().Trim();
        result = CollapseWhitespace(result);

        return result;
    }

    /// <summary>
    /// Removes diacritics (accents) from text.
    /// </summary>
    public static string RemoveDiacritics(string text)
    {
        if (string.IsNullOrEmpty(text))
            return text;

        var normalized = text.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalized.Length);

        foreach (var c in normalized)
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            if (category != UnicodeCategory.NonSpacingMark)
                sb.Append(c);
        }

        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    /// <summary>
    /// Strips HTML tags from text, preserving content.
    /// </summary>
    public static string StripHtml(string html)
    {
        if (string.IsNullOrEmpty(html))
            return string.Empty;

        // Remove script and style contents entirely
        var result = ScriptStyleRegex().Replace(html, string.Empty);

        // Replace common block elements with space
        result = BlockElementsRegex().Replace(result, " ");

        // Remove all remaining tags
        result = HtmlTagsRegex().Replace(result, string.Empty);

        // Decode common HTML entities
        result = DecodeHtmlEntities(result);

        // Collapse whitespace and trim
        result = CollapseWhitespace(result);

        return result.Trim();
    }

    /// <summary>
    /// Collapses multiple whitespace characters into single space.
    /// </summary>
    public static string CollapseWhitespace(string text)
    {
        if (string.IsNullOrEmpty(text))
            return text;

        return WhitespaceRegex().Replace(text, " ");
    }

    /// <summary>
    /// Tokenizes text into words.
    /// </summary>
    public static IReadOnlyList<string> Tokenize(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return [];

        return text
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 0)
            .ToList();
    }

    private static string DecodeHtmlEntities(string text)
    {
        return text
            .Replace("&nbsp;", " ")
            .Replace("&amp;", "&")
            .Replace("&lt;", "<")
            .Replace("&gt;", ">")
            .Replace("&quot;", "\"")
            .Replace("&#39;", "'")
            .Replace("&apos;", "'");
    }

    [GeneratedRegex(@"<(script|style)[^>]*>.*?</\1>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ScriptStyleRegex();

    [GeneratedRegex(@"</(p|div|br|h[1-6]|li|tr)>", RegexOptions.IgnoreCase)]
    private static partial Regex BlockElementsRegex();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex HtmlTagsRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}
