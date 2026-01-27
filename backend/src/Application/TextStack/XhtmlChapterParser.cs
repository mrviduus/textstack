using System.Xml.Linq;
using TextStack.Extraction.Utilities;

namespace Application.TextStack;

public record TsChapter(int Order, string Title, string Html, string PlainText, int WordCount);

public static class XhtmlChapterParser
{
    // SE branding/meta files to skip
    private static readonly HashSet<string> SkipFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        "colophon.xhtml",
        "titlepage.xhtml",
        "halftitlepage.xhtml",
        "frontispiece.xhtml",
        "loi.xhtml",
        "imprint.xhtml",
        "uncopyright.xhtml",
        "endnotes.xhtml",
        "dedication.xhtml",
        "introduction.xhtml",
        "preface.xhtml",
        "foreword.xhtml",
        "afterword.xhtml",
        "appendix.xhtml"
    };

    public static List<TsChapter> ParseFromToc(string tocPath, string textDir)
    {
        var chapters = new List<TsChapter>();
        var tocEntries = ParseToc(tocPath);
        var order = 0;

        foreach (var (href, title) in tocEntries)
        {
            var fileName = Path.GetFileName(href);
            if (SkipFiles.Contains(fileName))
                continue;

            var filePath = Path.Combine(textDir, fileName);
            if (!File.Exists(filePath))
                continue;

            var xhtml = File.ReadAllText(filePath);
            var (html, plainText) = HtmlCleaner.Clean(xhtml);
            var wordCount = HtmlCleaner.CountWords(plainText);

            // Skip files with no actual content (only metadata/titles)
            if (wordCount < 10)
                continue;

            var chapterTitle = !string.IsNullOrWhiteSpace(title)
                ? title
                : HtmlCleaner.ExtractTitle(xhtml) ?? $"Chapter {order + 1}";

            chapters.Add(new TsChapter(order, chapterTitle, html, plainText, wordCount));
            order++;
        }

        return chapters;
    }

    private static List<(string Href, string Title)> ParseToc(string tocPath)
    {
        var entries = new List<(string, string)>();

        var doc = XDocument.Load(tocPath);
        XNamespace xhtml = "http://www.w3.org/1999/xhtml";

        var nav = doc.Descendants(xhtml + "nav")
            .FirstOrDefault(n => n.Attribute("id")?.Value == "toc");

        if (nav == null)
            return entries;

        foreach (var anchor in nav.Descendants(xhtml + "a"))
        {
            var href = anchor.Attribute("href")?.Value;
            if (string.IsNullOrWhiteSpace(href))
                continue;

            // Clean title: remove roman numerals prefix like "I: ", "II: "
            var title = CleanTocTitle(anchor.Value);
            entries.Add((href, title));
        }

        return entries;
    }

    private static string CleanTocTitle(string raw)
    {
        var title = raw.Trim();

        // Remove leading roman numeral pattern like "I: " or "XII: "
        var colonIndex = title.IndexOf(':');
        if (colonIndex > 0 && colonIndex < 10)
        {
            var prefix = title[..colonIndex].Trim();
            if (IsRomanNumeral(prefix))
            {
                title = title[(colonIndex + 1)..].Trim();
            }
        }

        return title;
    }

    private static bool IsRomanNumeral(string s)
    {
        if (string.IsNullOrWhiteSpace(s))
            return false;

        foreach (var c in s.ToUpperInvariant())
        {
            if (c != 'I' && c != 'V' && c != 'X' && c != 'L' && c != 'C' && c != 'D' && c != 'M')
                return false;
        }

        return true;
    }
}
