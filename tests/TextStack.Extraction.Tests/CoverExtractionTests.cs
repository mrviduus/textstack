using TextStack.Extraction.Contracts;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

/// <summary>
/// E2E-style tests for cover extraction using real book files.
/// Focuses on EPUB format with cover image extraction.
/// </summary>
public class CoverExtractionTests
{
    private static string FixturesPath => Path.Combine(AppContext.BaseDirectory, "Fixtures");

    [Fact]
    public async Task Epub_Frankenstein_ExtractsCoverImage()
    {
        // Arrange
        var epubPath = Path.Combine(FixturesPath, "frankenstein.epub");
        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(epubPath);
        var request = new ExtractionRequest { Content = stream, FileName = "frankenstein.epub" };

        // Act
        var result = await extractor.ExtractAsync(request);

        // Assert
        Assert.NotNull(result.Metadata.CoverImage);
        Assert.True(result.Metadata.CoverImage.Length > 10000, "Cover >10KB");
        Assert.Equal("image/jpeg", result.Metadata.CoverMimeType);
    }
}
