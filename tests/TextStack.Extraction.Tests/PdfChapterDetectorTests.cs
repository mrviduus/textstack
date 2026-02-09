using TextStack.Extraction.Extractors.Pdf;
using TextStack.Extraction.Tests.Helpers;
using UglyToad.PdfPig;

namespace TextStack.Extraction.Tests;

public class PdfChapterDetectorTests
{
    [Fact]
    public void DetectChapters_NoBookmarksNoPatterns_FallsBackToPageSplit()
    {
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var doc = PdfDocument.Open(pdfBytes);

        var chapters = PdfChapterDetector.DetectChapters(doc);

        Assert.NotEmpty(chapters);
        // 30 pages / 15 per split = 2 chapters
        Assert.Equal(2, chapters.Count);
        Assert.Equal(1, chapters[0].StartPage);
        Assert.Equal(15, chapters[0].EndPage);
        Assert.Equal(16, chapters[1].StartPage);
        Assert.Equal(30, chapters[1].EndPage);
    }

    [Fact]
    public void DetectChapters_SmallDocument_SingleChapter()
    {
        var pdfBytes = PdfFixtureGenerator.GenerateSimplePdf(3);
        using var doc = PdfDocument.Open(pdfBytes);

        var chapters = PdfChapterDetector.DetectChapters(doc);

        // 3 pages < 15, so 1 page-split chapter
        Assert.Single(chapters);
        Assert.Equal(1, chapters[0].StartPage);
        Assert.Equal(3, chapters[0].EndPage);
    }

    [Fact]
    public void DetectChapters_WithSamplePdf_ReturnsChapters()
    {
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "sample_textlayer.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "sample_textlayer.pdf fixture not present");

        using var doc = PdfDocument.Open(fixturePath);
        var chapters = PdfChapterDetector.DetectChapters(doc);

        Assert.NotEmpty(chapters);
        Assert.True(chapters[0].StartPage >= 1);
        Assert.True(chapters[^1].EndPage <= doc.NumberOfPages);
    }

    [Fact]
    public void DetectChapters_PageSplit_TitlesContainPageRanges()
    {
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(20);
        using var doc = PdfDocument.Open(pdfBytes);

        var chapters = PdfChapterDetector.DetectChapters(doc);

        // Should fall back to page split (no bookmarks, no chapter patterns)
        Assert.All(chapters, c => Assert.Contains("Pages", c.Title!));
    }
}
