using System.Diagnostics;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

public class ImageOnlyPdfTests : IAsyncLifetime
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "Inspired - Marty Cagan.pdf");

    private ExtractionResult _result = null!;

    public async ValueTask InitializeAsync()
    {
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "Inspired - Marty Cagan.pdf" };
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
        await using var stream = File.OpenRead(FixturePath);
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
