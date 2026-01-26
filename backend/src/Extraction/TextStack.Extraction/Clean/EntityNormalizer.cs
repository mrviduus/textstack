using System.Net;
using System.Text.RegularExpressions;

namespace TextStack.Extraction.Clean;

/// <summary>
/// Normalizes HTML entities: decodes named/numeric entities, fixes double-encoding.
/// Ported from SE's clean.py entity handling.
/// </summary>
public static partial class EntityNormalizer
{
    // Entities to preserve as-is (required for valid HTML)
    private static readonly HashSet<string> PreserveEntities = new(StringComparer.OrdinalIgnoreCase)
    {
        "&amp;", "&lt;", "&gt;", "&quot;", "&apos;",
        "&#38;", "&#60;", "&#62;", "&#34;", "&#39;"
    };

    public static string Normalize(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // 1. Fix double-encoded entities (e.g., &amp;amp; -> &amp;)
        html = FixDoubleEncoded(html);

        // 2. Convert numeric entities to characters (except preserved ones)
        html = NumericEntityRegex().Replace(html, m =>
        {
            var entity = m.Value;
            if (PreserveEntities.Contains(entity))
                return entity;

            try
            {
                var decoded = WebUtility.HtmlDecode(entity);
                // Don't decode if it would create invalid HTML
                if (decoded == "<" || decoded == ">" || decoded == "&" || decoded == "\"")
                    return entity;
                return decoded;
            }
            catch
            {
                return entity;
            }
        });

        // 3. Convert named entities to characters (except preserved ones)
        html = NamedEntityRegex().Replace(html, m =>
        {
            var entity = m.Value;
            if (PreserveEntities.Contains(entity))
                return entity;

            try
            {
                var decoded = WebUtility.HtmlDecode(entity);
                // Don't decode if it produces same string (unknown entity)
                if (decoded == entity)
                    return entity;
                // Don't decode if it would create invalid HTML
                if (decoded == "<" || decoded == ">" || decoded == "&" || decoded == "\"")
                    return entity;
                return decoded;
            }
            catch
            {
                return entity;
            }
        });

        return html;
    }

    private static string FixDoubleEncoded(string html)
    {
        // Fix common double-encoding patterns
        var prev = html;
        var maxIterations = 3; // Prevent infinite loops

        for (var i = 0; i < maxIterations; i++)
        {
            html = html.Replace("&amp;amp;", "&amp;");
            html = html.Replace("&amp;lt;", "&lt;");
            html = html.Replace("&amp;gt;", "&gt;");
            html = html.Replace("&amp;quot;", "&quot;");
            html = html.Replace("&amp;apos;", "&apos;");
            html = html.Replace("&amp;nbsp;", "&nbsp;");
            html = html.Replace("&amp;#", "&#");

            if (html == prev)
                break;
            prev = html;
        }

        return html;
    }

    // Matches numeric entities: &#123; or &#x1F;
    [GeneratedRegex(@"&#x?[0-9a-fA-F]+;")]
    private static partial Regex NumericEntityRegex();

    // Matches named entities: &nbsp; &mdash; etc.
    [GeneratedRegex(@"&[a-zA-Z][a-zA-Z0-9]*;")]
    private static partial Regex NamedEntityRegex();
}
