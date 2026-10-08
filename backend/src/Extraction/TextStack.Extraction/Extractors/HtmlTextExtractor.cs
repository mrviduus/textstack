using System.Text;
using HtmlAgilityPack;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Toc;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Extractors;

/// <summary>
/// Extracts a single clean web article ("Send to TextStack" clip) into reader chapters.
/// Input is already-clean HTML (Readability runs in the browser extension); this just
/// sanitizes via <see cref="HtmlCleaner"/>, splits on h1/h2 when multi-section, and pulls
/// title/author/description metadata. Never enters the public Work/Edition/SSG path.
/// </summary>
public sealed class HtmlTextExtractor : ITextExtractor
{
    public SourceFormat SupportedFormat => SourceFormat.Html;

    public Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();

        string rawHtml;
        try
        {
            using var reader = new StreamReader(request.Content, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            rawHtml = reader.ReadToEnd();
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(ExtractionWarningCode.ParseError, $"Failed to read HTML: {ex.Message}"));
            return Task.FromResult(Empty(warnings));
        }

        if (string.IsNullOrWhiteSpace(rawHtml))
        {
            warnings.Add(new ExtractionWarning(ExtractionWarningCode.EmptyContent, "HTML clip was empty"));
            return Task.FromResult(Empty(warnings));
        }

        try
        {
            var (title, authors, description) = ExtractMetadata(rawHtml);

            var sections = SplitByHeadings(rawHtml);

            var units = new List<ContentUnit>();
            var tocChapters = new List<(int ChapterNumber, string Html)>();
            var order = 0;

            foreach (var (sectionTitle, sectionHtml) in sections)
            {
                ct.ThrowIfCancellationRequested(); // never a truncated clip

                var (cleanHtml, plainText) = HtmlCleaner.Clean(sectionHtml);
                if (string.IsNullOrWhiteSpace(plainText)) continue;

                var chapterNumber = order + 1;
                cleanHtml = TocGenerator.InjectAnchorIds(cleanHtml, chapterNumber);
                tocChapters.Add((chapterNumber, cleanHtml));

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Chapter,
                    Title: sectionTitle ?? title ?? $"Section {chapterNumber}",
                    Html: cleanHtml,
                    PlainText: plainText,
                    OrderIndex: order++,
                    WordCount: HtmlCleaner.CountWords(plainText)));
            }

            if (units.Count == 0)
            {
                warnings.Add(new ExtractionWarning(ExtractionWarningCode.EmptyContent, "No readable text in HTML clip"));
                return Task.FromResult(Empty(warnings));
            }

            // Fallback book title: supplied <title>/<h1> via ExtractTitle, else first unit's title.
            title ??= HtmlCleaner.ExtractTitle(rawHtml) ?? units[0].Title;

            var toc = TocGenerator.GenerateToc(tocChapters);
            var metadata = new ExtractionMetadata(title, authors, null, description);
            var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

            return Task.FromResult(new ExtractionResult(SourceFormat.Html, metadata, units, [], diagnostics, toc));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            warnings.Add(new ExtractionWarning(ExtractionWarningCode.ParseError, $"Failed to parse HTML clip: {ex.Message}"));
            return Task.FromResult(Empty(warnings));
        }
    }

    private static ExtractionResult Empty(IReadOnlyList<ExtractionWarning> warnings) => new(
        SourceFormat.Html,
        new ExtractionMetadata(null, null, null, null),
        [],
        [],
        new ExtractionDiagnostics(TextSource.None, null, warnings));

    /// <summary>
    /// Pulls book-level metadata from the RAW html (before HtmlCleaner strips &lt;head&gt;).
    /// title: first visible &lt;h1&gt; → &lt;title&gt;; author: &lt;meta name="author"&gt; → byline;
    /// description: &lt;meta name="description"&gt;.
    /// </summary>
    private static (string? Title, string? Authors, string? Description) ExtractMetadata(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);
        var root = doc.DocumentNode;

        var title = Clean(root.SelectSingleNode("//h1")?.InnerText)
                    ?? Clean(root.SelectSingleNode("//title")?.InnerText);

        var author = MetaContent(root, "author")
                     ?? Clean(root.SelectSingleNode("//*[contains(@class,'byline')]")?.InnerText);
        // "By Jane Doe" → "Jane Doe"
        if (author is not null && author.StartsWith("By ", StringComparison.OrdinalIgnoreCase))
            author = author[3..].Trim();

        var description = MetaContent(root, "description");

        return (title, NullIfEmpty(author), description);
    }

    private static string? MetaContent(HtmlNode root, string name)
    {
        var node = root.SelectSingleNode($"//meta[translate(@name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='{name}']");
        return NullIfEmpty(Clean(node?.GetAttributeValue("content", string.Empty)));
    }

    private static string? Clean(string? text)
        => string.IsNullOrWhiteSpace(text) ? null : HtmlEntity.DeEntitize(text).Trim();

    private static string? NullIfEmpty(string? text)
        => string.IsNullOrWhiteSpace(text) ? null : text;

    /// <summary>
    /// Splits article body into sections at each &lt;h1&gt;/&lt;h2&gt;. Single-section articles
    /// (the common case) return one unit. Content before the first heading is prepended to
    /// the first section so nothing is dropped.
    /// </summary>
    private static List<(string? Title, string Html)> SplitByHeadings(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        // Drop non-content nodes up front so they never land in a section.
        doc.DocumentNode.SelectNodes("//script|//style|//head|//noscript")?.ToList()
            .ForEach(n => n.Remove());

        var body = doc.DocumentNode.SelectSingleNode("//body") ?? doc.DocumentNode;

        // Flatten to top-level content nodes. If the article is wrapped in a single
        // <article>/<main>/<div>, descend into it so headings become siblings.
        var container = body;
        var elementChildren = container.ChildNodes.Where(n => n.NodeType == HtmlNodeType.Element).ToList();
        while (elementChildren.Count == 1 &&
               (elementChildren[0].Name is "article" or "main" or "div" or "section"))
        {
            container = elementChildren[0];
            elementChildren = container.ChildNodes.Where(n => n.NodeType == HtmlNodeType.Element).ToList();
        }

        var nodes = container.ChildNodes.ToList();
        var sections = new List<(string? Title, StringBuilder Html)>();
        StringBuilder? current = null;

        foreach (var node in nodes)
        {
            var isHeading = node.NodeType == HtmlNodeType.Element &&
                            (node.Name == "h1" || node.Name == "h2");

            if (isHeading)
            {
                var sectionTitle = Clean(node.InnerText);
                current = new StringBuilder();
                sections.Add((sectionTitle, current));
                current.Append(node.OuterHtml);
                continue;
            }

            if (current is null)
            {
                // Preamble before the first heading — open an untitled section.
                current = new StringBuilder();
                sections.Add((null, current));
            }

            current.Append(node.OuterHtml);
        }

        if (sections.Count == 0)
            return [(null, container.InnerHtml)];

        return sections.Select(s => (s.Title, s.Html.ToString())).ToList();
    }
}
