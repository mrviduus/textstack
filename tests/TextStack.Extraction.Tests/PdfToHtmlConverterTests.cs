using TextStack.Extraction.Extractors.Pdf;

namespace TextStack.Extraction.Tests;

public class PdfToHtmlConverterTests
{
    [Fact]
    public void ConvertPages_SimpleText_ProducesCleanParagraphs()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>
        {
            (1, [
                new PdfTextElement(TextElementType.Paragraph, "Hello world.", false, false),
                new PdfTextElement(TextElementType.Paragraph, "Second paragraph.", false, false)
            ])
        };

        var (html, plainText) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.Contains("<p>", html);
        Assert.Contains("Hello world", plainText);
        Assert.Contains("Second paragraph", plainText);
    }

    [Fact]
    public void ConvertPages_LargeFont_DetectsHeadings()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>
        {
            (1, [
                new PdfTextElement(TextElementType.Heading, "Chapter One", true, false),
                new PdfTextElement(TextElementType.Paragraph, "Some text here.", false, false)
            ])
        };

        var (html, plainText) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.Contains("<h2>", html);
        Assert.Contains("Chapter One", plainText);
    }

    [Fact]
    public void ConvertPages_BoldItalic_WrapsInlineElements()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>
        {
            (1, [
                new PdfTextElement(TextElementType.Paragraph, "Bold text", true, false),
                new PdfTextElement(TextElementType.Paragraph, "Italic text", false, true),
                new PdfTextElement(TextElementType.Paragraph, "Bold and italic", true, true)
            ])
        };

        var (html, _) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.Contains("<strong>", html);
        Assert.Contains("<em>", html);
    }

    [Fact]
    public void ConvertPages_EmptyInput_ReturnsEmpty()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>();

        var (html, plainText) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.Empty(html);
        Assert.Empty(plainText);
    }

    [Fact]
    public void ConvertPages_ImageElement_ProducesImgTag()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>
        {
            (1, [
                new PdfTextElement(TextElementType.Paragraph, "Before image.", false, false),
                new PdfTextElement(TextElementType.Image, "page-1-img-0", false, false),
                new PdfTextElement(TextElementType.Paragraph, "After image.", false, false)
            ])
        };

        var (html, plainText) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.Contains("<img", html);
        Assert.Contains("page-1-img-0", html);
        Assert.DoesNotContain("page-1-img-0", plainText);
    }

    [Fact]
    public void ConvertPages_HtmlSpecialChars_AreEncoded()
    {
        var pages = new List<(int PageNumber, List<PdfTextElement> Elements)>
        {
            (1, [
                new PdfTextElement(TextElementType.Paragraph, "A < B & C > D", false, false)
            ])
        };

        var (html, _) = PdfToHtmlConverter.ConvertPages(pages);

        Assert.DoesNotContain("< B", html);
        Assert.DoesNotContain("& C", html);
    }
}
