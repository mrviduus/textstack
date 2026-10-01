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
    // Tags that can execute script or hijack the page even after script/style are dropped.
    // Removed entirely (with their subtree) before attribute scrubbing. <base> rebases every
    // relative URL; <form>/<iframe>/<object>/<embed> are active vectors; <link>/<meta> can
    // load/redirect. Kept conservative so trusted-book prose (p/a/img/svg/figure/etc.) survives.
    private static readonly string[] DangerousTags =
        ["iframe", "object", "embed", "base", "form", "link", "meta", "noscript", "frame", "frameset", "applet"];

    // URL-bearing attributes scrubbed with the same scheme allowlist as href.
    private static readonly string[] UrlAttributes =
        ["href", "src", "srcset", "data", "action", "formaction", "poster", "background", "xlink:href"];

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

        RemoveDangerousTags(doc.DocumentNode);

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
        if (string.IsNullOrWhiteSpace(title))
            return null;

        var decoded = HtmlEntity.DeEntitize(title);

        // Reject placeholder titles from Calibre/Word conversions
        if (string.Equals(decoded, "Unknown", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(decoded, "Untitled", StringComparison.OrdinalIgnoreCase))
            return null;

        return decoded;
    }

    /// <summary>
    /// Like <see cref="ExtractTitle"/> but only considers VISIBLE headings
    /// (h1/h2/h3) — never the <c>&lt;head&gt;&lt;title&gt;</c> element. In many
    /// professionally-produced EPUBs every spine file's &lt;title&gt; is the
    /// BOOK title, so falling back to it mislabels chapters (and, via
    /// HasProperTitle, blocks the merge of a heading-only file with its body).
    /// Use this for per-chapter titling; use ExtractTitle for book-level title.
    /// </summary>
    public static string? ExtractHeadingTitle(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var headingNode = doc.DocumentNode.SelectSingleNode("//h1")
            ?? doc.DocumentNode.SelectSingleNode("//h2")
            ?? doc.DocumentNode.SelectSingleNode("//h3");

        var title = headingNode?.InnerText?.Trim();
        if (string.IsNullOrWhiteSpace(title))
            return null;

        var decoded = HtmlEntity.DeEntitize(title).Trim();

        if (string.Equals(decoded, "Unknown", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(decoded, "Untitled", StringComparison.OrdinalIgnoreCase))
            return null;

        return decoded;
    }

    public static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return 0;

        return text.Split([' ', '\t', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries).Length;
    }

    /// <summary>Tags → spaces, entities decoded, whitespace collapsed. Empty/null → "".</summary>
    public static string StripHtml(string? html)
    {
        if (string.IsNullOrEmpty(html))
            return string.Empty;
        var text = Regex.Replace(html, "<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        text = Regex.Replace(text, @"\s+", " ");
        return text.Trim();
    }

    /// <summary>
    /// Fixes self-closing non-void tags that break HAP parsing.
    /// HAP incorrectly parses &lt;script/&gt; and &lt;title/&gt; as unclosed, swallowing subsequent content.
    /// </summary>
    private static string FixSelfClosingTitle(string html)
    {
        return SelfClosingNonVoidRegex().Replace(html, "<$1$2></$1>");
    }

    [GeneratedRegex(@"<(script|title)(\s[^>]*)?\s*/>", RegexOptions.IgnoreCase)]
    private static partial Regex SelfClosingNonVoidRegex();

    private static void RemoveDangerousTags(HtmlNode root)
    {
        // Build an XPath union of //iframe|//object|... — case-insensitive because HAP
        // lower-cases element names on parse.
        var xpath = string.Join("|", DangerousTags.Select(t => $"//{t}"));
        root.SelectNodes(xpath)?.ToList().ForEach(n => n.Remove());
    }

    private static void RemoveDangerousAttributes(HtmlNode node)
    {
        foreach (var descendant in node.DescendantsAndSelf())
        {
            // Strip EVERY event handler (on*), not a fixed denylist — onerror/ontoggle/
            // onmouseenter/onanimationstart/etc. all execute script. Snapshot first:
            // we mutate the collection inside the loop.
            foreach (var attr in descendant.Attributes.ToList())
            {
                if (attr.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase))
                    descendant.Attributes.Remove(attr);
            }

            // Scrub every URL-bearing attribute with one scheme allowlist.
            foreach (var attrName in UrlAttributes)
            {
                var value = descendant.GetAttributeValue(attrName, "");
                if (string.IsNullOrEmpty(value))
                    continue;

                var sanitized = SanitizeUrl(attrName, value);
                if (sanitized is null)
                    descendant.Attributes.Remove(attrName);
                else if (!ReferenceEquals(sanitized, value))
                    descendant.SetAttributeValue(attrName, sanitized);
            }
        }
    }

    // Schemes that can execute or smuggle script. Anything matching is rejected; everything
    // else (http(s), mailto, RELATIVE paths like "OEBPS/img.jpg", protocol-relative, anchors,
    // and data:image/* used for inline covers) is allowed so trusted-book rendering is intact.
    private static readonly string[] DangerousSchemes =
        ["javascript:", "vbscript:", "file:", "blob:", "data:text/html"];

    /// <summary>
    /// Returns the value unchanged if safe, a neutered "#" for unsafe href-like links,
    /// or null to signal the attribute should be removed entirely (src/srcset/etc.).
    /// Only URLs whose scheme is in <see cref="DangerousSchemes"/> are treated as unsafe.
    /// Bare <c>data:</c> (without an image/* media type) is also rejected.
    /// </summary>
    private static string? SanitizeUrl(string attrName, string value)
    {
        // Browsers ignore leading/embedded control chars & whitespace when resolving the
        // scheme (e.g. "java\tscript:" → "javascript:"). Decode entities and strip those
        // chars up to the first ':' before matching so obfuscated payloads don't slip past.
        var decoded = HtmlEntity.DeEntitize(value) ?? value;
        var collapsed = new string(decoded.Where(c => c is not ('\t' or '\n' or '\r' or '\f' or '\0' or ' ')).ToArray());
        // srcset is a comma list of "url descriptor" pairs; check the first url.
        var firstUrl = attrName == "srcset"
            ? collapsed.Split(',')[0].Split(' ')[0]
            : collapsed;

        var isNavigational = attrName is "href" or "xlink:href";
        // data:image/* is safe as an <img src> (browsers never run script there) but a NAVIGATIONAL
        // data: link (href) opens in a document context where SVG/HTML scripts can run — reject those.
        var dataImageOk = firstUrl.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)
                          && !isNavigational
                          && !firstUrl.StartsWith("data:image/svg", StringComparison.OrdinalIgnoreCase);

        var unsafeScheme = DangerousSchemes.Any(s =>
                               firstUrl.StartsWith(s, StringComparison.OrdinalIgnoreCase))
                           || (firstUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && !dataImageOk);

        if (!unsafeScheme)
            return value; // safe — keep as-is (relative paths preserved for image rewrite)

        // href can be downgraded to a harmless anchor; everything else gets dropped.
        if (attrName is "href" or "xlink:href")
        {
            if (value.Contains('#'))
                return "#" + value.Split('#')[1];
            return "#";
        }

        return null; // remove src/srcset/data/action/formaction/poster/background
    }
}
