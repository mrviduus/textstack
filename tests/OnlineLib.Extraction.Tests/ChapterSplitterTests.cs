using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Services;

namespace OnlineLib.Extraction.Tests;

public class ChapterSplitterTests
{
    [Fact]
    public void Split_ChapterUnderLimit_ReturnsOriginalUnit()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 2000);
        var unit = CreateUnit(wordCount: 1500, title: "Short Chapter");

        var result = splitter.Split(unit, baseOrderIndex: 0, originalChapterNumber: 0);

        Assert.Single(result);
        Assert.Equal("Short Chapter", result[0].Title);
        Assert.Equal(0, result[0].OrderIndex);
        Assert.Equal(0, result[0].OriginalChapterNumber);
        Assert.Null(result[0].PartNumber);
        Assert.Null(result[0].TotalParts);
    }

    [Fact]
    public void Split_ChapterOverLimit_SplitsIntoParts()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 100);
        // Create HTML with multiple paragraphs
        var html = string.Join("", Enumerable.Range(1, 10).Select(i =>
            $"<p>{string.Join(" ", Enumerable.Repeat("word", 50))}</p>")); // 500 words total
        var plainText = string.Join(" ", Enumerable.Repeat("word", 500));

        var unit = new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: "Long Chapter",
            Html: html,
            PlainText: plainText,
            OrderIndex: 0,
            WordCount: 500
        );

        var result = splitter.Split(unit, baseOrderIndex: 0, originalChapterNumber: 0);

        Assert.True(result.Count > 1, $"Expected multiple parts, got {result.Count}");

        // Check first part
        Assert.Equal("Long Chapter - Part 1", result[0].Title);
        Assert.Equal(0, result[0].OrderIndex);
        Assert.Equal(0, result[0].OriginalChapterNumber);
        Assert.Equal(1, result[0].PartNumber);
        Assert.Equal(result.Count, result[0].TotalParts);

        // Check last part
        var last = result[^1];
        Assert.Equal($"Long Chapter - Part {result.Count}", last.Title);
        Assert.Equal(result.Count - 1, last.OrderIndex);
        Assert.Equal(0, last.OriginalChapterNumber);
        Assert.Equal(result.Count, last.PartNumber);
        Assert.Equal(result.Count, last.TotalParts);
    }

    [Fact]
    public void SplitAll_MixedChapters_PreservesOrderAndGrouping()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 100);

        var units = new List<ContentUnit>
        {
            // Short chapter - won't be split
            CreateUnit(wordCount: 50, title: "Chapter 1", orderIndex: 0),
            // Long chapter - will be split
            CreateLongUnit(wordCount: 300, title: "Chapter 2", orderIndex: 1),
            // Short chapter - won't be split
            CreateUnit(wordCount: 75, title: "Chapter 3", orderIndex: 2),
        };

        var result = splitter.SplitAll(units);

        // Chapter 1: 1 unit
        Assert.Equal("Chapter 1", result[0].Title);
        Assert.Equal(0, result[0].OriginalChapterNumber);
        Assert.Null(result[0].PartNumber);

        // Chapter 2: multiple parts
        var chapter2Parts = result.Where(u => u.OriginalChapterNumber == 1).ToList();
        Assert.True(chapter2Parts.Count > 1, "Chapter 2 should be split");
        Assert.All(chapter2Parts, p =>
        {
            Assert.Equal(1, p.OriginalChapterNumber);
            Assert.NotNull(p.PartNumber);
            Assert.Equal(chapter2Parts.Count, p.TotalParts);
        });

        // Chapter 3: 1 unit (after all Chapter 2 parts)
        var chapter3 = result.First(u => u.OriginalChapterNumber == 2);
        Assert.Equal("Chapter 3", chapter3.Title);
        Assert.Null(chapter3.PartNumber);
    }

    [Fact]
    public void SplitAll_OrderIndicesAreSequential()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 100);

        var units = new List<ContentUnit>
        {
            CreateLongUnit(wordCount: 250, title: "Chapter 1", orderIndex: 0),
            CreateLongUnit(wordCount: 250, title: "Chapter 2", orderIndex: 1),
        };

        var result = splitter.SplitAll(units);

        // Verify order indices are sequential starting from 0
        for (int i = 0; i < result.Count; i++)
        {
            Assert.Equal(i, result[i].OrderIndex);
        }
    }

    [Fact]
    public void Split_NullWordCount_ReturnsOriginalUnit()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 100);
        var unit = new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: "Unknown Length",
            Html: "<p>Some content</p>",
            PlainText: "Some content",
            OrderIndex: 0,
            WordCount: null
        );

        var result = splitter.Split(unit, baseOrderIndex: 0, originalChapterNumber: 0);

        Assert.Single(result);
        Assert.Equal("Unknown Length", result[0].Title);
    }

    [Fact]
    public void Split_PreservesContentUnitType()
    {
        var splitter = new ChapterSplitter(maxWordsPerPart: 100);
        var unit = CreateLongUnit(wordCount: 250, title: "Test", orderIndex: 0);
        unit = unit with { Type = ContentUnitType.Page };

        var result = splitter.Split(unit, baseOrderIndex: 0, originalChapterNumber: 0);

        Assert.All(result, r => Assert.Equal(ContentUnitType.Page, r.Type));
    }

    private static ContentUnit CreateUnit(int wordCount, string title, int orderIndex = 0)
    {
        var plainText = string.Join(" ", Enumerable.Repeat("word", wordCount));
        return new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: title,
            Html: $"<p>{plainText}</p>",
            PlainText: plainText,
            OrderIndex: orderIndex,
            WordCount: wordCount
        );
    }

    private static ContentUnit CreateLongUnit(int wordCount, string title, int orderIndex = 0)
    {
        // Create unit with multiple paragraphs for splitting
        var wordsPerParagraph = 50;
        var paragraphCount = (wordCount + wordsPerParagraph - 1) / wordsPerParagraph;
        var html = string.Join("", Enumerable.Range(1, paragraphCount).Select(i =>
            $"<p>{string.Join(" ", Enumerable.Repeat("word", Math.Min(wordsPerParagraph, wordCount - (i - 1) * wordsPerParagraph)))}</p>"));
        var plainText = string.Join(" ", Enumerable.Repeat("word", wordCount));

        return new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: title,
            Html: html,
            PlainText: plainText,
            OrderIndex: orderIndex,
            WordCount: wordCount
        );
    }
}
