using System.Text;
using System.Text.RegularExpressions;
using HtmlAgilityPack;
using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.TextProcessing.Pipeline;

namespace TextStack.Extraction.Utilities;

/// <summary>
/// Cleans HTML content using the text processing pipeline.
/// </summary>
public partial class HtmlCleaner
{
    private static readonly string[] DangerousAttributes = ["onclick", "onload", "onerror", "onmouseover", "onfocus", "onblur"];

    private readonly IProcessingPipeline _pipeline;
    private readonly TextProcessingOptions _options;

    /// <summary>
    /// Create HtmlCleaner with custom pipeline or default.
    /// </summary>
    public HtmlCleaner(IProcessingPipeline? pipeline = null, TextProcessingOptions? options = null)
    {
        _options = options ?? new TextProcessingOptions();
        _pipeline = pipeline ?? PipelineBuilder.CreateDefault(_options).Build();
    }

    /// <summary>
    /// Clean HTML content.
    /// </summary>
    public (string Html, string PlainText) CleanHtml(string html, string? language = null)
    {
        // 1. NFC normalize
        html = html.Normalize(NormalizationForm.FormC);

        // 2. Fix self-closing non-void tags that break HAP parsing
        // HAP treats <title/> as unclosed, swallowing all subsequent content
        html = FixSelfClosingTitle(html);

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        doc.DocumentNode.SelectNodes("//script|//style|//head")?.ToList()
            .ForEach(n => n.Remove());

        var body = doc.DocumentNode.SelectSingleNode("//body");
        var content = body ?? doc.DocumentNode;

        RemoveDangerousAttributes(content);

        var cleanHtml = content.InnerHtml.Trim();

        // 3. Run through processing pipeline
        var context = new ProcessingContext(language ?? _options.Language, _options);
        var (processedHtml, plainText) = _pipeline.Process(cleanHtml, context);
        return (processedHtml, plainText);
    }

    /// <summary>
    /// Static method for backward compatibility.
    /// </summary>
    public static (string Html, string PlainText) Clean(string html)
        => new HtmlCleaner().CleanHtml(html);

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

    /// <summary>
    /// Fixes self-closing title tag that breaks HAP parsing.
    /// HAP incorrectly parses &lt;title/&gt; as unclosed, swallowing subsequent content.
    /// </summary>
    private static string FixSelfClosingTitle(string html)
    {
        // Simple string replacement for the most common case
        // This avoids regex which can cause issues in some environments
        return html
            .Replace("<title/>", "<title></title>")
            .Replace("<title />", "<title></title>");
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
}
