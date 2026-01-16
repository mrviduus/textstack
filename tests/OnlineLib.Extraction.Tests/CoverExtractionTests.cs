using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Extractors;

namespace OnlineLib.Extraction.Tests;

/// <summary>
/// E2E-style tests for cover extraction using real book files.
/// Focuses on PDF format with cover image extraction.
/// </summary>
public class CoverExtractionTests
{
    private static string FixturesPath => Path.Combine(AppContext.BaseDirectory, "Fixtures");

    #region PDF Cover Extraction Tests

    [Fact]
    public async Task Pdf_SampleWithTextLayer_ExtractsCoverAsPng()
    {
        // Arrange - PDF with text layer, cover = first page rendered as PNG
        var pdfPath = Path.Combine(FixturesPath, "sample_textlayer.pdf");
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(pdfPath);
        var request = new ExtractionRequest { Content = stream, FileName = "sample_textlayer.pdf" };

        // Act
        var result = await extractor.ExtractAsync(request);

        // Assert
        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
        Assert.NotNull(result.Metadata.CoverImage);
        Assert.True(result.Metadata.CoverImage.Length > 1000, "Cover should be >1KB");
        Assert.Equal("image/png", result.Metadata.CoverMimeType);

        // Verify PNG signature (89 50 4E 47)
        Assert.Equal(0x89, result.Metadata.CoverImage[0]);
        Assert.Equal(0x50, result.Metadata.CoverImage[1]); // P
        Assert.Equal(0x4E, result.Metadata.CoverImage[2]); // N
        Assert.Equal(0x47, result.Metadata.CoverImage[3]); // G
    }

    [Fact]
    public async Task Pdf_SampleWithTextLayer_ExtractsTextContent()
    {
        // Arrange
        var pdfPath = Path.Combine(FixturesPath, "sample_textlayer.pdf");
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(pdfPath);
        var request = new ExtractionRequest { Content = stream, FileName = "sample_textlayer.pdf" };

        // Act
        var result = await extractor.ExtractAsync(request);

        // Assert
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
        Assert.NotEmpty(result.Units);
        Assert.True(result.Units.Sum(u => u.WordCount) > 0, "Should extract text");
    }

    [Fact]
    public async Task Pdf_InvalidStream_ReturnsEmptyWithWarning()
    {
        // Arrange
        var extractor = new PdfTextExtractor();
        using var stream = new MemoryStream("not a pdf"u8.ToArray());
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.pdf" };

        // Act
        var result = await extractor.ExtractAsync(request);

        // Assert - should not throw, should have warning
        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
        Assert.NotEmpty(result.Diagnostics.Warnings);
    }

    [Fact]
    public async Task Pdf_CoverImage_IsValidPng()
    {
        // Arrange
        var pdfPath = Path.Combine(FixturesPath, "sample_textlayer.pdf");
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(pdfPath);
        var request = new ExtractionRequest { Content = stream, FileName = "test.pdf" };

        // Act
        var result = await extractor.ExtractAsync(request);

        // Assert - PNG should be decodable
        Assert.NotNull(result.Metadata.CoverImage);

        // PNG has IHDR chunk after signature (8 bytes) + length (4 bytes)
        // IHDR at offset 12-15 should be "IHDR"
        Assert.True(result.Metadata.CoverImage.Length > 24, "PNG too small");
        Assert.Equal((byte)'I', result.Metadata.CoverImage[12]);
        Assert.Equal((byte)'H', result.Metadata.CoverImage[13]);
        Assert.Equal((byte)'D', result.Metadata.CoverImage[14]);
        Assert.Equal((byte)'R', result.Metadata.CoverImage[15]);
    }

    #endregion

    #region EPUB Tests (for completeness)

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

    #endregion
}
