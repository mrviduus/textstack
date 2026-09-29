using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Outline;

namespace TextStack.Extraction.Extractors.Pdf;

/// <summary>
/// Detects chapter boundaries in a PDF via a fallback cascade:
/// 1. PDF Bookmarks (outlines)
/// 2. TOC-anchored — parse the Table of Contents, anchor each title to the body
/// 3. Heading heuristics (large font / "Chapter N" / ALL-CAPS / numbered / roman)
/// 4. Page-based splitting (~15 pages per chapter)
/// </summary>
public static class PdfChapterDetector
{
    private const int PageSplitSize = 15;
    private const int HeadingScanMaxPages = 100;

    // Explicit "Chapter 1 / Part II / Розділ 3" style openers (multi-language).
    private static readonly Regex ChapterPattern = new(
        @"^(chapter|глава|розділ|part|частина|часть)\s+(\d+|[IVXLCDM]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Numbered section opener without the word "Chapter": "1. URGENT AND
    // EMERGENT EYE CARE", "12. Cornea". Common in Word→PDF exports.
    private static readonly Regex NumberedHeading = new(
        @"^\d{1,3}[\.\)]\s+\p{L}",
        RegexOptions.Compiled);

    // Roman-numeral / "PART I" section opener without a following word count:
    // "II. INFECTIOUS", "IV. INFLAMMATORY", "PART ONE".
    private static readonly Regex RomanHeading = new(
        @"^(part\s+)?[IVXLCDM]{1,4}[\.\)]\s+\p{L}",
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

        // Level 2: TOC-anchored — clean titles + real physical pages, no offset.
        var tocChapters = PdfTocParser.TryDetect(document, pageCount);
        if (tocChapters.Count > 1)
            return tocChapters;

        // Level 3: Try heading heuristics
        var headingChapters = TryDetectFromHeadings(document, pageCount);
        if (headingChapters.Count > 1)
            return headingChapters;

        // Level 4: Page-based splitting
        return SplitByPages(pageCount);
    }

    private static List<ChapterRange> TryDetectFromBookmarks(PdfDocument document, int pageCount)
    {
        try
        {
            if (!document.TryGetBookmarks(out var bookmarks))
                return [];

            var chapters = SelectChapters(bookmarks.Roots.Select(ToOutline).ToList());

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

    /// <summary>A bookmark reduced to what chapter selection needs; <c>Page</c> 0 = no page target.</summary>
    internal sealed record OutlineNode(string Title, int Page, IReadOnlyList<OutlineNode> Children);

    private static OutlineNode ToOutline(BookmarkNode node) => new(
        node.Title?.Trim() ?? string.Empty,
        node is DocumentBookmarkNode doc ? doc.PageNumber : 0,
        node.Children.Select(ToOutline).ToList());

    // "Part I", "Part One", "Частина 2", "Book III" — a grouping level above chapters.
    private static readonly Regex PartTitle = new(
        @"^(part|частина|часть|book|книга)\s+(\d+|[IVXLCDM]+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Chapters from the top of the outline. Top-level only by default: flattening the tree conflates
    /// chapters with their subsections, and an O'Reilly-style book would produce 30+ "chapters"
    /// instead of ~10.
    /// <para>
    /// Except when a top-level entry is a PART: DDIA's roots are "Part I. Foundations of Data Systems"
    /// (pp. 23–166) with "Chapter 1…4" beneath, so top-level-only gave three 150–240-page "chapters"
    /// and the real chapters vanished. A root is expanded into its children when it reads like a part,
    /// or when at least two of its children read like chapters ("Chapter 5", "5. Replication") — the
    /// second covers books whose part roots carry no "Part" word. A chapter's subsections ("Leaders and
    /// Followers") read like neither, so ordinary chapter roots stay whole. The part's own opening
    /// pages are folded into its first chapter rather than becoming a two-page chapter of their own.
    /// </para>
    /// </summary>
    internal static List<(string Title, int PageNumber)> SelectChapters(IReadOnlyList<OutlineNode> roots)
    {
        var chapters = new List<(string Title, int PageNumber)>();
        foreach (var root in roots)
        {
            var paged = root.Children.Where(c => c.Page > 0 && c.Title.Length > 0).ToList();
            var isPart = PartTitle.IsMatch(root.Title)
                || paged.Count(c => ChapterPattern.IsMatch(c.Title) || NumberedHeading.IsMatch(c.Title)) >= 2;

            if (isPart && paged.Count >= 2)
            {
                for (var i = 0; i < paged.Count; i++)
                {
                    var page = i == 0 && root.Page > 0 ? Math.Min(root.Page, paged[0].Page) : paged[i].Page;
                    chapters.Add((paged[i].Title, page));
                }
                continue;
            }

            if (root.Page > 0)
            {
                if (root.Title.Length > 0)
                    chapters.Add((root.Title, root.Page));
                continue;
            }

            // A "section header" root with no page of its own: take its first child's page so the
            // branch isn't lost, titled by the root when it has a title.
            var first = paged.FirstOrDefault();
            if (first is not null)
                chapters.Add((root.Title.Length > 0 ? root.Title : first.Title, first.Page));
        }
        return chapters;
    }

    private static List<ChapterRange> TryDetectFromHeadings(PdfDocument document, int pageCount)
    {
        try
        {
            var chapterStarts = new List<(string Title, int PageNumber)>();

            var scanLimit = Math.Min(pageCount, HeadingScanMaxPages);

            for (var i = 1; i <= scanLimit; i++)
            {
                var page = document.GetPage(i);
                var elements = PdfPageTextExtractor.ExtractPage(page);
                if (elements.Count == 0)
                    continue;

                var firstElement = elements[0];
                if (IsChapterStart(firstElement))
                {
                    chapterStarts.Add((CleanHeading(firstElement.Text), i));
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

    private const int MaxCapsHeadingLength = 60;

    /// <summary>
    /// A page-leading element is a chapter start when it is an explicit
    /// "Chapter/Part N" opener, a numbered ("1. Title") or roman ("II. Title")
    /// section opener, a font-flagged heading, or a short standalone ALL-CAPS
    /// line. Kept conservative — only fires on the FIRST element of a page.
    /// </summary>
    private static bool IsChapterStart(PdfTextElement element)
    {
        var text = element.Text?.Trim() ?? string.Empty;
        if (text.Length == 0)
            return false;

        if (ChapterPattern.IsMatch(text)
            || NumberedHeading.IsMatch(text)
            || RomanHeading.IsMatch(text))
            return true;

        // Short line that is entirely uppercase letters (allowing digits /
        // punctuation / spaces) — a bare section header like "CORNEAL ULCER".
        // A font-flagged heading only counts when it ALSO reads like a caps
        // header; a bare large-font running label ("Page 3") must not split.
        if (text.Length <= MaxCapsHeadingLength && IsAllCaps(text))
            return true;

        return false;
    }

    private static bool IsAllCaps(string text)
    {
        var hasLetter = false;
        foreach (var c in text)
        {
            if (char.IsLetter(c))
            {
                if (char.IsLower(c))
                    return false;
                hasLetter = true;
            }
        }
        return hasLetter;
    }

    // Trim a glued body sentence off an ALL-CAPS header ("RETINAL DETACHMENT
    // Rhegmatogenous…" → "RETINAL DETACHMENT"): keep the leading run of
    // uppercase words, stop at the first word containing a lowercase letter.
    private static string CleanHeading(string text)
    {
        var normalized = Regex.Replace(text.Trim(), @"\s+", " ");
        var words = normalized.Split(' ');
        if (!words[0].Any(char.IsLower))
        {
            var kept = new List<string>();
            foreach (var w in words)
            {
                if (kept.Count > 0 && w.Any(char.IsLower))
                    break;
                kept.Add(w);
            }
            if (kept.Count > 0)
                normalized = string.Join(' ', kept);
        }
        return normalized;
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
