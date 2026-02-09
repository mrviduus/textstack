using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Outline;

namespace TextStack.Extraction.Extractors.Pdf;

/// <summary>
/// Detects chapter boundaries in a PDF via 3-level fallback:
/// 1. PDF Bookmarks (outlines)
/// 2. Heading heuristics (large font / "Chapter N" patterns)
/// 3. Page-based splitting (~15 pages per chapter)
/// </summary>
public static class PdfChapterDetector
{
    private const int PageSplitSize = 15;

    private static readonly Regex ChapterPattern = new(
        @"^(chapter|глава|розділ|part|частина|часть)\s+(\d+|[IVXLCDM]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static List<ChapterRange> DetectChapters(PdfDocument document)
    {
        var pageCount = document.NumberOfPages;
        if (pageCount == 0)
            return [];

        // Level 1: Try bookmarks
        var bookmarkChapters = TryDetectFromBookmarks(document, pageCount);
        if (bookmarkChapters.Count > 1)
            return bookmarkChapters;

        // Level 2: Try heading heuristics
        var headingChapters = TryDetectFromHeadings(document, pageCount);
        if (headingChapters.Count > 1)
            return headingChapters;

        // Level 3: Page-based splitting
        return SplitByPages(pageCount);
    }

    private static List<ChapterRange> TryDetectFromBookmarks(PdfDocument document, int pageCount)
    {
        try
        {
            if (!document.TryGetBookmarks(out var bookmarks))
                return [];

            var chapters = new List<(string Title, int PageNumber)>();

            foreach (var node in bookmarks.GetNodes())
            {
                if (node is DocumentBookmarkNode docNode && docNode.PageNumber > 0)
                {
                    var title = docNode.Title?.Trim();
                    if (!string.IsNullOrWhiteSpace(title))
                        chapters.Add((title, docNode.PageNumber));
                }
            }

            if (chapters.Count < 2)
                return [];

            // De-duplicate and sort by page number
            var sorted = chapters
                .DistinctBy(c => c.PageNumber)
                .OrderBy(c => c.PageNumber)
                .ToList();

            var result = new List<ChapterRange>();
            for (var i = 0; i < sorted.Count; i++)
            {
                var endPage = i < sorted.Count - 1
                    ? sorted[i + 1].PageNumber - 1
                    : pageCount;
                result.Add(new ChapterRange(sorted[i].Title, sorted[i].PageNumber, endPage));
            }

            return result;
        }
        catch
        {
            return [];
        }
    }

    private static List<ChapterRange> TryDetectFromHeadings(PdfDocument document, int pageCount)
    {
        try
        {
            var chapterStarts = new List<(string Title, int PageNumber)>();

            // Only scan first 100 pages for heading patterns to avoid slow perf
            var scanLimit = Math.Min(pageCount, 100);

            for (var i = 1; i <= scanLimit; i++)
            {
                var page = document.GetPage(i);
                var elements = PdfPageTextExtractor.ExtractPage(page);
                if (elements.Count == 0)
                    continue;

                var firstElement = elements[0];
                // Only match explicit chapter patterns, not arbitrary headings
                if (ChapterPattern.IsMatch(firstElement.Text))
                {
                    chapterStarts.Add((firstElement.Text, i));
                }
            }

            if (chapterStarts.Count < 2)
                return [];

            var result = new List<ChapterRange>();
            for (var i = 0; i < chapterStarts.Count; i++)
            {
                var endPage = i < chapterStarts.Count - 1
                    ? chapterStarts[i + 1].PageNumber - 1
                    : pageCount;
                result.Add(new ChapterRange(chapterStarts[i].Title, chapterStarts[i].PageNumber, endPage));
            }

            return result;
        }
        catch
        {
            return [];
        }
    }

    private static List<ChapterRange> SplitByPages(int pageCount)
    {
        var result = new List<ChapterRange>();
        for (var start = 1; start <= pageCount; start += PageSplitSize)
        {
            var end = Math.Min(start + PageSplitSize - 1, pageCount);
            result.Add(new ChapterRange($"Pages {start}\u2013{end}", start, end));
        }
        return result;
    }
}
