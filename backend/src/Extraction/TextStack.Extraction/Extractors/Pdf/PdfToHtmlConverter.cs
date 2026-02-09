using System.Text;
using System.Web;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Extractors.Pdf;

/// <summary>
/// Converts structured PDF page text into clean HTML + plain text.
/// </summary>
public static class PdfToHtmlConverter
{
    public static (string Html, string PlainText) ConvertPages(
        IReadOnlyList<(int PageNumber, List<PdfTextElement> Elements)> pages)
    {
        var htmlBuilder = new StringBuilder();
        var plainBuilder = new StringBuilder();

        foreach (var (_, elements) in pages)
        {
            foreach (var element in elements)
            {
                if (element.Type == TextElementType.Image)
                {
                    if (!string.IsNullOrWhiteSpace(element.Text))
                        htmlBuilder.Append($"<img src=\"{HttpUtility.HtmlAttributeEncode(element.Text)}\" alt=\"\" />");
                    continue;
                }

                if (string.IsNullOrWhiteSpace(element.Text))
                    continue;

                var encoded = HttpUtility.HtmlEncode(element.Text);
                var inline = WrapInline(encoded, element.IsBold, element.IsItalic);

                switch (element.Type)
                {
                    case TextElementType.Heading:
                        htmlBuilder.Append($"<h2>{inline}</h2>");
                        break;
                    case TextElementType.Paragraph:
                        htmlBuilder.Append($"<p>{inline}</p>");
                        break;
                }

                plainBuilder.AppendLine(element.Text);
            }
        }

        var rawHtml = htmlBuilder.ToString();
        if (string.IsNullOrWhiteSpace(rawHtml))
            return (string.Empty, string.Empty);

        // Run through HtmlCleaner for typography/spelling/hyphenation pipeline
        var (cleanHtml, cleanPlain) = HtmlCleaner.Clean(rawHtml);
        return (cleanHtml, cleanPlain);
    }

    private static string WrapInline(string text, bool bold, bool italic)
    {
        if (bold && italic)
            return $"<strong><em>{text}</em></strong>";
        if (bold)
            return $"<strong>{text}</strong>";
        if (italic)
            return $"<em>{text}</em>";
        return text;
    }
}
