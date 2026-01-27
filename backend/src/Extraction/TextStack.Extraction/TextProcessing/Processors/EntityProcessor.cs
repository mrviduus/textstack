using System.Net;
using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Normalizes HTML entities: decodes named/numeric entities, fixes double-encoding.
/// </summary>
public class EntityProcessor : ITextProcessor
{
    public string Name => "Entity";
    public int Order => 200;

    private static readonly Regex NumericEntityRegex = new(@"&#x?[0-9a-fA-F]+;", RegexOptions.Compiled);
    private static readonly Regex NamedEntityRegex = new(@"&[a-zA-Z][a-zA-Z0-9]*;", RegexOptions.Compiled);

    // Entities to preserve as-is (required for valid HTML)
    private static readonly HashSet<string> PreserveEntities = new(StringComparer.OrdinalIgnoreCase)
    {
        "&amp;", "&lt;", "&gt;", "&quot;", "&apos;",
        "&#38;", "&#60;", "&#62;", "&#34;", "&#39;"
    };

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;

        // 1. Fix double-encoded entities (e.g., &amp;amp; -> &amp;)
        html = FixDoubleEncoded(html);

        // 2. Convert numeric entities to characters (except preserved ones)
        html = NumericEntityRegex.Replace(html, m =>
        {
            var entity = m.Value;
            if (PreserveEntities.Contains(entity))
                return entity;

            try
            {
                var decoded = WebUtility.HtmlDecode(entity);
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
        html = NamedEntityRegex.Replace(html, m =>
        {
            var entity = m.Value;
            if (PreserveEntities.Contains(entity))
                return entity;

            try
            {
                var decoded = WebUtility.HtmlDecode(entity);
                if (decoded == entity)
                    return entity;
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
        var prev = html;
        var maxIterations = 3;

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
}
