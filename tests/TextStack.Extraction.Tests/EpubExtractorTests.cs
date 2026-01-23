using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

public class EpubExtractorTests
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "minimal.epub");

    [Fact]
    public async Task ExtractAsync_ValidEpub_ReturnsUnitsWithMetadata()
    {
        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "minimal.epub" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotEmpty(result.Units);
        Assert.Equal("Minimal Test Book", result.Metadata.Title);
        Assert.Equal("Test Author", result.Metadata.Authors);
        Assert.Equal(SourceFormat.Epub, result.SourceFormat);
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
    }

    [Fact]
    public async Task ExtractAsync_InvalidStream_NeverThrows()
    {
        var extractor = new EpubTextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("not a valid epub"));
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.epub" };

        var exception = await Record.ExceptionAsync(() => extractor.ExtractAsync(request));

        Assert.Null(exception);
    }
}
