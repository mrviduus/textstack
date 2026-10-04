using System.Diagnostics;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Tests.Helpers;

namespace TextStack.Extraction.Tests;

public class ImageOnlyPdfTests : IAsyncLifetime
{
    // Generated, not a real scanned book: the repo is public and must not carry copyrighted files.
    private static readonly byte[] Pdf = PdfFixtureGenerator.GenerateImageOnlyPdf();

    private ExtractionResult _result = null!;

    public async ValueTask InitializeAsync()
    {
        var extractor = new PdfTextExtractor();
        await using var stream = new MemoryStream(Pdf);
        var request = new ExtractionRequest { Content = stream, FileName = "scanned.pdf" };
        _result = await extractor.ExtractAsync(request);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_DoesNotThrow()
        => Assert.NotNull(_result);

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_ReturnsTextSourceNone()
        => Assert.Equal(TextSource.None, _result.Diagnostics.TextSource);

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_EmitsNoTextLayerWarning()
    {
        var warning = Assert.Single(_result.Diagnostics.Warnings,
            w => w.Code == ExtractionWarningCode.NoTextLayer);
        Assert.Contains("image-only", warning.Message);
    }

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_ReturnsZeroUnits()
        => Assert.Empty(_result.Units);

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_NoCover()
    {
        Assert.Null(_result.Metadata.CoverImage);
        Assert.Null(_result.Metadata.CoverMimeType);
    }

    [Fact]
    public async Task ExtractAsync_ImageOnlyPdf_CompletesWithin10Seconds()
    {
        // Re-run timed to verify early bailout
        var sw = Stopwatch.StartNew();
        var extractor = new PdfTextExtractor();
        await using var stream = new MemoryStream(Pdf);
        var request = new ExtractionRequest { Content = stream, FileName = "test.pdf" };
        await extractor.ExtractAsync(request);
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10),
            $"Took {sw.Elapsed.TotalSeconds:F1}s — expected <10s for early bailout");
    }

    [Fact]
    public void ExtractAsync_ImageOnlyPdf_ReturnsSourceFormatPdf()
        => Assert.Equal(SourceFormat.Pdf, _result.SourceFormat);
}
