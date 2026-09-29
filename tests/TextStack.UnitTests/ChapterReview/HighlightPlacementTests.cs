using Application.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class HighlightPlacementTests
{
    private static readonly ChapterRef One = new(Guid.NewGuid(), "one", 0, "One", 10, 20);
    private static readonly ChapterRef Two = new(Guid.NewGuid(), "two", 1, "Two", 20, 30); // shares page 20
    private static readonly ChapterRef[] Chapters = [One, Two];

    private static string Pdf(int page) =>
        $$"""{"v":1,"kind":"pdf","page":{{page}},"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.02}],"exact":"x"}""";

    [Fact]
    public void IsIn_ReflowHighlight_ByChapterId()
    {
        var h = new HighlightRef(Guid.NewGuid(), One.Id, """{"exact":"x"}""");

        Assert.True(HighlightPlacement.IsIn(h, One));
        Assert.False(HighlightPlacement.IsIn(h, Two));
        Assert.Equal(0, HighlightPlacement.ChapterNumberOf(h, Chapters));
    }

    [Fact]
    public void IsIn_PdfHighlight_ByPageRange_SharedPageInBoth()
    {
        var shared = new HighlightRef(Guid.NewGuid(), null, Pdf(20));
        var inTwo = new HighlightRef(Guid.NewGuid(), null, Pdf(25));

        Assert.True(HighlightPlacement.IsIn(shared, One));
        Assert.True(HighlightPlacement.IsIn(shared, Two));
        Assert.False(HighlightPlacement.IsIn(inTwo, One));
        Assert.Equal(1, HighlightPlacement.ChapterNumberOf(shared, Chapters));
    }

    [Fact]
    public void ChapterNumberOf_PdfBeforeFirstChapterOrNoPage_Null()
    {
        Assert.Null(HighlightPlacement.ChapterNumberOf(new(Guid.NewGuid(), null, Pdf(2)), Chapters));
        Assert.Null(HighlightPlacement.ChapterNumberOf(new(Guid.NewGuid(), null, """{"exact":"x"}"""), Chapters));
        Assert.Null(HighlightPlacement.ChapterNumberOf(new(Guid.NewGuid(), null, "not json"), Chapters));
    }

    [Fact]
    public void IsIn_PdfChapterWithoutRanges_False()
    {
        var h = new HighlightRef(Guid.NewGuid(), null, Pdf(15));
        Assert.False(HighlightPlacement.IsIn(h, One with { StartPage = null, EndPage = null }));
    }

    [Theory]
    [InlineData("""{"kind":"pdf","page":"7"}""")]
    [InlineData("""{"kind":"text","page":7}""")]
    [InlineData("[]")]
    public void PdfPage_NotAPdfPageAnchor_Null(string anchor)
    {
        Assert.Null(HighlightPlacement.PdfPage(anchor));
    }
}
