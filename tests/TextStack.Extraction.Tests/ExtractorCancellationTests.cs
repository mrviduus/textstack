using TextStack.Extraction.Contracts;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Tests.Helpers;

namespace TextStack.Extraction.Tests;

/// <summary>
/// ADR-022: a cancelled extraction (the Worker stopping for a deploy) throws. Returning what was read
/// so far would be saved as the whole book, or read as "no text layer" and fail the job.
/// </summary>
public class ExtractorCancellationTests
{
    private static CancellationToken Cancelled() => new(canceled: true);

    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "Fixtures", name);

    [Fact]
    public async Task ExtractAsync_PdfCancelled_Throws()
    {
        using var stream = new MemoryStream(PdfFixtureGenerator.GenerateMultiPagePdf(30));
        var request = new ExtractionRequest { Content = stream, FileName = "book.pdf" };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new PdfTextExtractor().ExtractAsync(request, Cancelled()));
    }

    [Fact]
    public async Task ExtractAsync_HtmlCancelled_Throws()
    {
        await using var stream = File.OpenRead(Fixture("article.html"));
        var request = new ExtractionRequest { Content = stream, FileName = "original.html" };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new HtmlTextExtractor().ExtractAsync(request, Cancelled()));
    }

    [Fact]
    public async Task ExtractAsync_EpubCancelled_Throws()
    {
        await using var stream = File.OpenRead(Fixture("frankenstein.epub"));
        var request = new ExtractionRequest { Content = stream, FileName = "frankenstein.epub" };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new EpubTextExtractor().ExtractAsync(request, Cancelled()));
    }
}
