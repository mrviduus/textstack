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
    public void DetectChapters_WordQuartzWorkbook_DetectsRealTitledChapters()
    {
        var fixturePath = Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "KMK Optometry OSCE E-Workbook.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "KMK OSCE workbook fixture not present");

        using var doc = PdfDocument.Open(fixturePath);
        var chapters = PdfChapterDetector.DetectChapters(doc);

        // TOC-anchored detection must beat the page-split fallback.
        Assert.True(chapters.Count > 1, $"expected multiple chapters, got {chapters.Count}");

        // Real section titles, never the "Pages 1–15" page-split labels.
        Assert.All(chapters, c =>
        {
            Assert.False(string.IsNullOrWhiteSpace(c.Title));
            Assert.DoesNotContain("Pages ", c.Title!, StringComparison.Ordinal);
        });

        // The book's actual sections surface (case-insensitive).
        var titles = string.Join(" | ", chapters.Select(c => c.Title));
        Assert.True(
            titles.Contains("Urgent", StringComparison.OrdinalIgnoreCase)
            || titles.Contains("Corneal", StringComparison.OrdinalIgnoreCase),
            $"expected a real section title, got: {titles}");

        // Ranges are ordered and in-bounds.
        for (var i = 0; i < chapters.Count; i++)
        {
            Assert.True(chapters[i].StartPage >= 1);
            Assert.True(chapters[i].EndPage <= doc.NumberOfPages);
            Assert.True(chapters[i].EndPage >= chapters[i].StartPage);
            if (i > 0)
                Assert.True(chapters[i].StartPage > chapters[i - 1].StartPage);
        }
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

    // ── SelectChapters: which outline level holds the chapters ───────────────────

    private static PdfChapterDetector.OutlineNode N(string title, int page, params PdfChapterDetector.OutlineNode[] children) =>
        new(title, page, children);

    [Fact]
    public void SelectChapters_PartRootsWithChapterChildren_ExpandsToChapters()
    {
        // The shape of the owner's DDIA PDF: parts on top, chapters below, sections below that.
        var roots = new[]
        {
            N("Preface", 15, N("Who Should Read This Book?", 16)),
            N("Part I. Foundations of Data Systems", 23,
                N("Chapter 1. Reliable, Scalable, and Maintainable Applications", 25,
                    N("Thinking About Data Systems", 26), N("Reliability", 28)),
                N("Chapter 2. Data Models and Query Languages", 49)),
            N("Part II. Distributed Data", 167,
                N("Chapter 5. Replication", 173, N("Leaders and Followers", 174)),
                N("Chapter 6. Partitioning", 221)),
            N("Glossary", 575),
        };

        var chapters = PdfChapterDetector.SelectChapters(roots);

        Assert.Equal(
            ["Preface", "Chapter 1. Reliable, Scalable, and Maintainable Applications",
             "Chapter 2. Data Models and Query Languages", "Chapter 5. Replication",
             "Chapter 6. Partitioning", "Glossary"],
            chapters.Select(c => c.Title));
        // The part's opening pages belong to its first chapter, not to a two-page chapter of their own.
        Assert.Equal(23, chapters[1].PageNumber);
        Assert.Equal(167, chapters[3].PageNumber);
        Assert.Equal(221, chapters[4].PageNumber);
    }

    [Fact]
    public void SelectChapters_PartWithoutPartWord_ExpandsWhenChildrenReadLikeChapters()
    {
        var roots = new[]
        {
            N("Foundations of Data Systems", 23, N("1. Reliable Applications", 25), N("2. Data Models", 49)),
            N("Distributed Data", 167, N("5. Replication", 173), N("6. Partitioning", 221)),
        };

        var titles = PdfChapterDetector.SelectChapters(roots).Select(c => c.Title).ToList();

        Assert.Equal(["1. Reliable Applications", "2. Data Models", "5. Replication", "6. Partitioning"], titles);
    }

    [Fact]
    public void SelectChapters_ChapterRootsWithSections_StayWhole()
    {
        // O'Reilly style: the roots ARE the chapters; their children are sections and must not become chapters.
        var roots = new[]
        {
            N("Chapter 1. Getting Started", 10, N("Installing", 11), N("First Steps", 14), N("Summary", 20)),
            N("Chapter 2. The Basics", 22, N("Variables", 23), N("Control Flow", 27)),
        };

        var chapters = PdfChapterDetector.SelectChapters(roots);

        Assert.Equal(["Chapter 1. Getting Started", "Chapter 2. The Basics"], chapters.Select(c => c.Title));
        Assert.Equal([10, 22], chapters.Select(c => c.PageNumber));
    }

    [Fact]
    public void SelectChapters_PartWithSingleChild_StaysWhole()
    {
        var roots = new[] { N("Part I", 5, N("Chapter 1. Only", 7)), N("Part II", 40) };

        var chapters = PdfChapterDetector.SelectChapters(roots);

        Assert.Equal(["Part I", "Part II"], chapters.Select(c => c.Title));
    }

    [Fact]
    public void SelectChapters_RootWithoutPage_TakesFirstChildPage_TitledByRoot()
    {
        var roots = new[] { N("Introduction", 0, N("Why", 3), N("How", 6)), N("Chapter 1", 10) };

        var chapters = PdfChapterDetector.SelectChapters(roots);

        Assert.Equal(("Introduction", 3), chapters[0]);
        Assert.Equal(("Chapter 1", 10), chapters[1]);
    }
}
