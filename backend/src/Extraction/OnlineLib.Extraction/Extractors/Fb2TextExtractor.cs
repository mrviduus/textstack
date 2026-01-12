using System.Text;
using System.Xml.Linq;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Services;
using OnlineLib.Extraction.Utilities;

namespace OnlineLib.Extraction.Extractors;

public sealed class Fb2TextExtractor : ITextExtractor
{
    private static readonly XNamespace Fb2Ns = "http://www.gribuser.ru/xml/fictionbook/2.0";

    public SourceFormat SupportedFormat => SourceFormat.Fb2;

    public async Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();

        XDocument doc;
        try
        {
            doc = await XDocument.LoadAsync(request.Content, LoadOptions.None, ct);
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"Failed to parse FB2: {ex.Message}"));

            return new ExtractionResult(
                SourceFormat.Fb2,
                new ExtractionMetadata(null, null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        var root = doc.Root;
        if (root == null)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                "FB2 document has no root element"));

            return new ExtractionResult(
                SourceFormat.Fb2,
                new ExtractionMetadata(null, null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Handle both namespaced and non-namespaced FB2
        var ns = root.GetDefaultNamespace();

        var metadata = ExtractMetadata(root, ns);
        var units = ExtractSections(root, ns, warnings, ct);

        ct.ThrowIfCancellationRequested();

        // Split long chapters into smaller parts
        var splitter = new ChapterSplitter(request.Options.MaxWordsPerPart);
        var splitUnits = splitter.SplitAll(units);

        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);
        return new ExtractionResult(SourceFormat.Fb2, metadata, splitUnits, diagnostics);
    }

    private static ExtractionMetadata ExtractMetadata(XElement root, XNamespace ns)
    {
        var description = root.Element(ns + "description");
        var titleInfo = description?.Element(ns + "title-info");

        string? title = null;
        string? authors = null;
        string? language = null;
        string? annotation = null;
        byte[]? coverImage = null;
        string? coverMimeType = null;

        if (titleInfo != null)
        {
            // Title
            var bookTitle = titleInfo.Element(ns + "book-title");
            title = bookTitle?.Value?.Trim();

            // Authors
            var authorElements = titleInfo.Elements(ns + "author").ToList();
            if (authorElements.Count > 0)
            {
                var authorNames = authorElements
                    .Select(a => ExtractAuthorName(a, ns))
                    .Where(n => !string.IsNullOrWhiteSpace(n))
                    .ToList();
                authors = authorNames.Count > 0 ? string.Join(", ", authorNames) : null;
            }

            // Language
            var lang = titleInfo.Element(ns + "lang");
            language = lang?.Value?.Trim();

            // Annotation (description)
            var annotationEl = titleInfo.Element(ns + "annotation");
            if (annotationEl != null)
            {
                annotation = ExtractPlainTextFromElement(annotationEl);
            }

            // Cover image
            try
            {
                var coverpage = titleInfo.Element(ns + "coverpage");
                var imageEl = coverpage?.Element(ns + "image");
                if (imageEl != null)
                {
                    // Get href attribute (can be l:href or xlink:href)
                    var xlinkNs = XNamespace.Get("http://www.w3.org/1999/xlink");
                    var href = imageEl.Attribute(xlinkNs + "href")?.Value
                            ?? imageEl.Attribute("href")?.Value;

                    if (!string.IsNullOrEmpty(href))
                    {
                        // Remove leading # if present
                        var binaryId = href.TrimStart('#');

                        // Find the binary element
                        var binaryEl = root.Elements(ns + "binary")
                            .FirstOrDefault(b => b.Attribute("id")?.Value == binaryId);

                        if (binaryEl != null)
                        {
                            var contentType = binaryEl.Attribute("content-type")?.Value;
                            var base64 = binaryEl.Value;

                            if (!string.IsNullOrWhiteSpace(base64))
                            {
                                coverImage = Convert.FromBase64String(base64.Trim());
                                coverMimeType = contentType ?? "image/jpeg";
                            }
                        }
                    }
                }
            }
            catch
            {
                // Cover extraction is optional, don't fail on error
            }
        }

        return new ExtractionMetadata(title, authors, language, annotation, coverImage, coverMimeType);
    }

    private static string? ExtractAuthorName(XElement author, XNamespace ns)
    {
        var firstName = author.Element(ns + "first-name")?.Value?.Trim() ?? "";
        var middleName = author.Element(ns + "middle-name")?.Value?.Trim() ?? "";
        var lastName = author.Element(ns + "last-name")?.Value?.Trim() ?? "";
        var nickname = author.Element(ns + "nickname")?.Value?.Trim() ?? "";

        var parts = new[] { firstName, middleName, lastName }
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .ToList();

        if (parts.Count > 0)
            return string.Join(" ", parts);

        return !string.IsNullOrWhiteSpace(nickname) ? nickname : null;
    }

    private static List<ContentUnit> ExtractSections(
        XElement root,
        XNamespace ns,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        var units = new List<ContentUnit>();
        var body = root.Element(ns + "body");

        if (body == null)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.EmptyContent,
                "FB2 document has no body element"));
            return units;
        }

        var sections = body.Elements(ns + "section").ToList();
        var order = 0;

        if (sections.Count == 0)
        {
            // No sections, treat entire body as one unit
            var html = ConvertToHtml(body, ns);
            var plainText = ExtractPlainTextFromElement(body);

            if (!string.IsNullOrWhiteSpace(plainText))
            {
                units.Add(new ContentUnit(
                    Type: ContentUnitType.Chapter,
                    Title: "Content",
                    Html: html,
                    PlainText: plainText,
                    OrderIndex: 0,
                    WordCount: HtmlCleaner.CountWords(plainText)));
            }
            return units;
        }

        foreach (var section in sections)
        {
            if (ct.IsCancellationRequested)
                break;

            try
            {
                var unit = ExtractSection(section, ns, order);
                if (unit != null)
                {
                    units.Add(unit);
                    order++;
                }
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.ChapterParseError,
                    $"Failed to parse section: {ex.Message}"));
            }
        }

        return units;
    }

    private static ContentUnit? ExtractSection(XElement section, XNamespace ns, int order)
    {
        var titleEl = section.Element(ns + "title");
        var title = titleEl != null
            ? ExtractPlainTextFromElement(titleEl)?.Trim()
            : null;

        if (string.IsNullOrWhiteSpace(title))
            title = $"Chapter {order + 1}";

        var html = ConvertToHtml(section, ns);
        var plainText = ExtractPlainTextFromElement(section);

        if (string.IsNullOrWhiteSpace(plainText))
            return null;

        return new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: title,
            Html: html,
            PlainText: plainText,
            OrderIndex: order,
            WordCount: HtmlCleaner.CountWords(plainText));
    }

    private static string ConvertToHtml(XElement element, XNamespace ns)
    {
        var sb = new StringBuilder();
        ConvertElementToHtml(element, ns, sb);
        return sb.ToString();
    }

    private static void ConvertElementToHtml(XElement element, XNamespace ns, StringBuilder sb)
    {
        var localName = element.Name.LocalName.ToLowerInvariant();

        switch (localName)
        {
            case "p":
                sb.Append("<p>");
                AppendChildContent(element, ns, sb);
                sb.Append("</p>");
                break;

            case "title":
                sb.Append("<h2>");
                foreach (var p in element.Elements(ns + "p"))
                {
                    AppendChildContent(p, ns, sb);
                    sb.Append(' ');
                }
                sb.Append("</h2>");
                break;

            case "subtitle":
                sb.Append("<h3>");
                AppendChildContent(element, ns, sb);
                sb.Append("</h3>");
                break;

            case "epigraph":
                sb.Append("<blockquote class=\"epigraph\">");
                foreach (var child in element.Elements())
                    ConvertElementToHtml(child, ns, sb);
                sb.Append("</blockquote>");
                break;

            case "cite":
                sb.Append("<blockquote>");
                foreach (var child in element.Elements())
                    ConvertElementToHtml(child, ns, sb);
                sb.Append("</blockquote>");
                break;

            case "poem":
                sb.Append("<div class=\"poem\">");
                foreach (var child in element.Elements())
                    ConvertElementToHtml(child, ns, sb);
                sb.Append("</div>");
                break;

            case "stanza":
                sb.Append("<div class=\"stanza\">");
                foreach (var v in element.Elements(ns + "v"))
                {
                    sb.Append("<p class=\"verse\">");
                    AppendChildContent(v, ns, sb);
                    sb.Append("</p>");
                }
                sb.Append("</div>");
                break;

            case "v":
                sb.Append("<p class=\"verse\">");
                AppendChildContent(element, ns, sb);
                sb.Append("</p>");
                break;

            case "emphasis":
                sb.Append("<em>");
                AppendChildContent(element, ns, sb);
                sb.Append("</em>");
                break;

            case "strong":
                sb.Append("<strong>");
                AppendChildContent(element, ns, sb);
                sb.Append("</strong>");
                break;

            case "a":
                var href = element.Attribute(XNamespace.Xml + "href")?.Value
                    ?? element.Attribute("href")?.Value
                    ?? "#";
                sb.Append($"<a href=\"{EscapeHtml(href)}\">");
                AppendChildContent(element, ns, sb);
                sb.Append("</a>");
                break;

            case "section":
                sb.Append("<section>");
                foreach (var child in element.Elements())
                    ConvertElementToHtml(child, ns, sb);
                sb.Append("</section>");
                break;

            case "empty-line":
                sb.Append("<br/>");
                break;

            case "image":
                // Skip binary images for now
                break;

            default:
                // For unknown elements, just process children
                foreach (var child in element.Elements())
                    ConvertElementToHtml(child, ns, sb);
                break;
        }
    }

    private static void AppendChildContent(XElement element, XNamespace ns, StringBuilder sb)
    {
        foreach (var node in element.Nodes())
        {
            if (node is XText text)
            {
                sb.Append(EscapeHtml(text.Value));
            }
            else if (node is XElement child)
            {
                ConvertElementToHtml(child, ns, sb);
            }
        }
    }

    private static string ExtractPlainTextFromElement(XElement element)
    {
        var sb = new StringBuilder();
        ExtractTextRecursive(element, sb);
        return NormalizeWhitespace(sb.ToString());
    }

    private static void ExtractTextRecursive(XElement element, StringBuilder sb)
    {
        foreach (var node in element.Nodes())
        {
            if (node is XText text)
            {
                sb.Append(text.Value);
            }
            else if (node is XElement child)
            {
                var localName = child.Name.LocalName.ToLowerInvariant();

                // Add space before block elements
                if (localName is "p" or "title" or "subtitle" or "v" or "empty-line")
                    sb.Append(' ');

                ExtractTextRecursive(child, sb);

                // Add space after block elements
                if (localName is "p" or "title" or "subtitle" or "v" or "empty-line")
                    sb.Append(' ');
            }
        }
    }

    private static string NormalizeWhitespace(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        var sb = new StringBuilder(text.Length);
        var lastWasSpace = true;

        foreach (var c in text)
        {
            if (char.IsWhiteSpace(c))
            {
                if (!lastWasSpace)
                {
                    sb.Append(' ');
                    lastWasSpace = true;
                }
            }
            else
            {
                sb.Append(c);
                lastWasSpace = false;
            }
        }

        return sb.ToString().Trim();
    }

    private static string EscapeHtml(string text)
    {
        return text
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;");
    }
}
