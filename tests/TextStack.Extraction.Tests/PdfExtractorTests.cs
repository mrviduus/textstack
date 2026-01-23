using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

public class PdfExtractorTests
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "sample_textlayer.pdf");

    [Fact]
    public async Task ExtractAsync_ValidPdf_ReturnsUnitsWithMetadata()
    {
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "sample_textlayer.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotEmpty(result.Units);
        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
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
}
