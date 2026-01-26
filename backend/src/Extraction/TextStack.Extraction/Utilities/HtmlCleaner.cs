using System.Text;
using System.Text.RegularExpressions;
using HtmlAgilityPack;
using TextStack.Extraction.Clean;
using TextStack.Extraction.Spelling;
using TextStack.Extraction.Typography;

namespace TextStack.Extraction.Utilities;

public static partial class HtmlCleaner
{
    private static readonly string[] BlockTags = ["p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"];
    private static readonly string[] DangerousAttributes = ["onclick", "onload", "onerror", "onmouseover", "onfocus", "onblur"];

    public static (string Html, string PlainText) CleanHtml(string html)
    {
        // 1. NFC normalize
        html = html.Normalize(NormalizationForm.FormC);

        // 2. Whitespace normalization (collapse spaces, normalize line breaks)
        html = WhitespaceNormalizer.Normalize(html);

        // 3. Entity normalization (decode entities, fix double-encoding)
        html = EntityNormalizer.Normalize(html);

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        doc.DocumentNode.SelectNodes("//script|//style|//head")?.ToList()
            .ForEach(n => n.Remove());

        var body = doc.DocumentNode.SelectSingleNode("//body");
        var content = body ?? doc.DocumentNode;

        RemoveDangerousAttributes(content);

        var cleanHtml = content.InnerHtml.Trim();

        // 4. Remove empty tags
        cleanHtml = EmptyTagRemover.Remove(cleanHtml);

        // 5. Spelling modernization (archaic → modern spellings)
        cleanHtml = SpellingProcessor.ModernizeSpelling(cleanHtml);
        cleanHtml = HyphenationModernizer.ModernizeHyphenation(cleanHtml);

        // 6. Typography processing (smart quotes, dashes, ellipses, fractions)
        cleanHtml = TypographyProcessor.Typogrify(cleanHtml);

        // 7. Semantic processing (abbreviations, roman numerals, measurements)
        cleanHtml = SemanticProcessor.Semanticate(cleanHtml);

        var plainText = ExtractPlainText(content);

        return (cleanHtml, plainText);
    }

    public static string? ExtractTitle(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var titleNode = doc.DocumentNode.SelectSingleNode("//h1")
            ?? doc.DocumentNode.SelectSingleNode("//h2")
            ?? doc.DocumentNode.SelectSingleNode("//title");

        var title = titleNode?.InnerText?.Trim();
        if (!string.IsNullOrWhiteSpace(title))
            return HtmlEntity.DeEntitize(title);

        return null;
    }

    public static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return 0;

        return text.Split([' ', '\t', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries).Length;
    }

    private static void RemoveDangerousAttributes(HtmlNode node)
    {
        foreach (var descendant in node.DescendantsAndSelf())
        {
            foreach (var attr in DangerousAttributes)
            {
                descendant.Attributes.Remove(attr);
            }

            var href = descendant.GetAttributeValue("href", "");
            if (!string.IsNullOrEmpty(href))
            {
                if (href.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase))
                {
                    descendant.SetAttributeValue("href", "#");
                }
                else if (!href.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                         !href.StartsWith("https://", StringComparison.OrdinalIgnoreCase) &&
                         !href.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
                {
                    if (href.StartsWith('#'))
                    {
                        // Keep anchor-only links
                    }
                    else if (href.Contains('#'))
                    {
                        descendant.SetAttributeValue("href", "#" + href.Split('#')[1]);
                    }
                    else
                    {
                        descendant.SetAttributeValue("href", "#");
                    }
                }
            }
        }
    }

    private static string ExtractPlainText(HtmlNode node)
    {
        var sb = new StringBuilder();
        ExtractTextRecursive(node, sb);
        var text = sb.ToString();
        text = WhitespaceRegex().Replace(text, " ");
        return text.Trim();
    }

    private static void ExtractTextRecursive(HtmlNode node, StringBuilder sb)
    {
        if (node.NodeType == HtmlNodeType.Text)
        {
            var text = HtmlEntity.DeEntitize(node.InnerText);
            sb.Append(text);
            return;
        }

        if (BlockTags.Contains(node.Name.ToLowerInvariant()))
            sb.Append(' ');

        foreach (var child in node.ChildNodes)
        {
            ExtractTextRecursive(child, sb);
        }

        if (BlockTags.Contains(node.Name.ToLowerInvariant()))
            sb.Append(' ');
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}
