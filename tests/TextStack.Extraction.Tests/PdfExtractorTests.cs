using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Tests.Helpers;

namespace TextStack.Extraction.Tests;

public class PdfExtractorTests
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "sample_textlayer.pdf");

    [Fact]
    public async Task ExtractAsync_ValidPdf_ReturnsCorrectFormat()
    {
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "sample.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
        // sample_textlayer.pdf may or may not have enough words for NativeText
        Assert.True(result.Diagnostics.TextSource == TextSource.NativeText ||
                    result.Diagnostics.TextSource == TextSource.None);
    }

    [Fact]
    public async Task ExtractAsync_InvalidStream_NeverThrows()
    {
        var extractor = new PdfTextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("not a valid pdf"));
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.pdf" };

        var exception = await Record.ExceptionAsync(() => extractor.ExtractAsync(request));

        Assert.Null(exception);
    }

    [Fact]
    public async Task ExtractAsync_EmptyPdf_ReturnsWarning()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateEmptyPdf();
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "empty.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Equal(TextSource.None, result.Diagnostics.TextSource);
        Assert.True(result.Diagnostics.Warnings.Count > 0);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ReturnsUnitsWithText()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotEmpty(result.Units);
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ExtractsText()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        var allText = string.Join(" ", result.Units.Select(u => u.PlainText));
        Assert.NotEmpty(allText.Trim());
        Assert.Contains("Lorem ipsum", allText);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ChaptersHaveTitlesAndWordCount()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.All(result.Units, u =>
        {
            Assert.NotNull(u.Title);
            Assert.NotNull(u.Html);
            Assert.NotEmpty(u.PlainText);
            Assert.True(u.WordCount > 0);
        });
    }

    [Fact]
    public async Task ExtractAsync_PdfWithJpeg_ExtractsCoverImage()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GeneratePdfWithJpegImage(10);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "with-image.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotNull(result.Metadata.CoverImage);
        Assert.NotEmpty(result.Metadata.CoverImage);
        Assert.Equal("image/jpeg", result.Metadata.CoverMimeType);
        Assert.Contains(result.Images, img => img.IsCover);
    }

    [Fact]
    public async Task ExtractAsync_PdfWithImages_HasImgTagsInHtml()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GeneratePdfWithImagesOnMultiplePages(10);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "with-images.pdf" };

        var result = await extractor.ExtractAsync(request);

        var allHtml = string.Join(" ", result.Units.Select(u => u.Html));
        Assert.Contains("<img", allHtml);
        Assert.Contains("page-1-img-0", allHtml);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_FallsBackToPageSplitting()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        // 30 pages / 15 per split = 2 chapters
        Assert.Equal(2, result.Units.Count);
    }
}
