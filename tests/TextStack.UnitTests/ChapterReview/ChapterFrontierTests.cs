using Application.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class ChapterFrontierTests
{
    private static readonly ChapterRef[] Chapters =
    [
        new(Guid.NewGuid(), "one", 0, "One", 10, 19),
        new(Guid.NewGuid(), "two", 1, "Two", 20, 29),
        new(Guid.NewGuid(), "three", 2, "Three", 35, 49), // pages 30–34 are a gap
        new(Guid.NewGuid(), "four", 3, "Four", 50, 60),
    ];

    private static ChapterRef[] Unranged => Chapters.Select(c => c with { StartPage = null, EndPage = null }).ToArray();

    // ── catalog ──

    [Fact]
    public void Resolve_CatalogCompleted_LastChapter()
    {
        var p = new ProgressSnapshot(DateTimeOffset.UtcNow, MaxChapterNumber: 0);
        Assert.Equal(3, ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Fact]
    public void Resolve_CatalogHighWater_UsesMaxChapterNumberNotCurrentChapter()
    {
        // Jumped back to chapter one after reading to three: the high-water mark still holds.
        var p = new ProgressSnapshot(null, MaxChapterNumber: 2, ChapterId: Chapters[0].Id);
        Assert.Equal(2, ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Fact]
    public void Resolve_CatalogNoHighWater_ChapterOfChapterId()
    {
        var p = new ProgressSnapshot(null, ChapterId: Chapters[1].Id);
        Assert.Equal(1, ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Fact]
    public void Resolve_CatalogIgnoresReviewedMax()
    {
        var p = new ProgressSnapshot(null, MaxChapterNumber: 0);
        Assert.Equal(0, ChapterFrontier.Resolve(p, Chapters, maxReviewedNumber: 3));
    }

    // ── upload, reflow ──

    [Fact]
    public void Resolve_UploadCompletedOrNearlyDone_LastChapter()
    {
        Assert.Equal(3, ChapterFrontier.Resolve(new(DateTimeOffset.UtcNow, IsUpload: true), Chapters, null));
        Assert.Equal(3, ChapterFrontier.Resolve(new(null, Percent: 0.995, ChapterSlug: "one", IsUpload: true), Chapters, null));
    }

    [Fact]
    public void Resolve_UploadReflow_ChapterOfSlug()
    {
        var p = new ProgressSnapshot(null, Percent: 0.4, ChapterSlug: "two", Locator: "scroll:two:120", IsUpload: true);
        Assert.Equal(1, ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Fact]
    public void Resolve_UploadUnknownSlug_Null()
    {
        var p = new ProgressSnapshot(null, ChapterSlug: "gone", IsUpload: true);
        Assert.Null(ChapterFrontier.Resolve(p, Chapters, null));
    }

    // ── upload, PDF original ──

    [Theory]
    [InlineData(10, 0)]  // first page of chapter one
    [InlineData(25, 1)]  // inside two
    [InlineData(32, 1)]  // gap after two → still two
    [InlineData(35, 2)]  // first page of three
    [InlineData(999, 3)] // past the end → last
    public void Resolve_PdfPage_ChapterWithGreatestStartAtOrBefore(int page, int expected)
    {
        var p = new ProgressSnapshot(null, Percent: 0.3, Locator: $"page:{page}", IsUpload: true);
        Assert.Equal(expected, ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Fact]
    public void Resolve_PdfPageBeforeFirstChapter_Null()
    {
        var p = new ProgressSnapshot(null, Percent: 0.01, Locator: "page:3", IsUpload: true);
        Assert.Null(ChapterFrontier.Resolve(p, Chapters, null));
    }

    [Theory]
    [InlineData(0.10, 0)] // ceil(0.4) = 1 → first
    [InlineData(0.50, 1)] // ceil(2.0) = 2 → second
    [InlineData(0.51, 2)] // ceil(2.04) = 3 → third
    public void Resolve_PdfNoPageRanges_FallsBackToPercent(double percent, int expected)
    {
        var p = new ProgressSnapshot(null, Percent: percent, Locator: "page:7", IsUpload: true);
        Assert.Equal(expected, ChapterFrontier.Resolve(p, Unranged, null));
    }

    [Fact]
    public void Resolve_PdfNoPageRangesNoPercent_Null()
    {
        var p = new ProgressSnapshot(null, Locator: "page:7", IsUpload: true);
        Assert.Null(ChapterFrontier.Resolve(p, Unranged, null));
    }

    // ── rescue + none ──

    [Fact]
    public void Resolve_UploadReReadEarlierChapter_ReviewedMaxRescues()
    {
        // Reviewed chapter four, then went back to re-read two: re-running four must still work.
        var p = new ProgressSnapshot(null, ChapterSlug: "two", IsUpload: true);
        Assert.Equal(3, ChapterFrontier.Resolve(p, Chapters, maxReviewedNumber: 3));
    }

    [Fact]
    public void Resolve_UploadNoPositionButReviewed_ReviewedMax()
    {
        Assert.Equal(1, ChapterFrontier.Resolve(new(null, IsUpload: true), Chapters, maxReviewedNumber: 1));
    }

    [Fact]
    public void Resolve_NoProgress_Null()
    {
        Assert.Null(ChapterFrontier.Resolve(null, Chapters, null));
        Assert.Null(ChapterFrontier.Resolve(new(null, IsUpload: true), Chapters, null));
    }

    [Fact]
    public void Resolve_NoChapters_Null()
    {
        Assert.Null(ChapterFrontier.Resolve(new(DateTimeOffset.UtcNow), [], null));
    }
}
