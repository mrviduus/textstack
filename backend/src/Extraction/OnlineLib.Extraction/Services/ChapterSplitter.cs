using System.Text;
using HtmlAgilityPack;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Utilities;

namespace OnlineLib.Extraction.Services;

public sealed class ChapterSplitter
{
    public const int DefaultMaxWordsPerPart = 2000;

    private readonly int _maxWordsPerPart;

    public ChapterSplitter(int maxWordsPerPart = DefaultMaxWordsPerPart)
    {
        _maxWordsPerPart = maxWordsPerPart;
    }

    /// <summary>
    /// Splits a content unit into smaller parts if it exceeds the max word count.
    /// Each part is a separate ContentUnit with updated title and order index.
    /// </summary>
    public IReadOnlyList<ContentUnit> Split(ContentUnit unit, int baseOrderIndex, int originalChapterNumber)
    {
        if (unit.WordCount == null || unit.WordCount <= _maxWordsPerPart)
        {
            // Not split - return as-is with original chapter number set
            return [unit with {
                OrderIndex = baseOrderIndex,
                OriginalChapterNumber = originalChapterNumber,
                PartNumber = null,
                TotalParts = null
            }];
        }

        var parts = SplitHtmlAtParagraphs(unit.Html ?? "", unit.Title ?? "Chapter");
        var result = new List<ContentUnit>();
        var totalParts = parts.Count;

        for (int i = 0; i < parts.Count; i++)
        {
            var (html, plainText, wordCount) = parts[i];
            var partTitle = parts.Count > 1
                ? $"{unit.Title} - Part {i + 1}"
                : unit.Title;

            result.Add(new ContentUnit(
                Type: unit.Type,
                Title: partTitle,
                Html: html,
                PlainText: plainText,
                OrderIndex: baseOrderIndex + i,
                WordCount: wordCount,
                OriginalChapterNumber: originalChapterNumber,
                PartNumber: i + 1,
                TotalParts: totalParts
            ));
        }

        return result;
    }

    /// <summary>
    /// Splits all units in a list, flattening into a single list with proper order indices.
    /// Each unit's original OrderIndex is used as the OriginalChapterNumber for grouping.
    /// </summary>
    public IReadOnlyList<ContentUnit> SplitAll(IReadOnlyList<ContentUnit> units)
    {
        var result = new List<ContentUnit>();
        var currentIndex = 0;

        foreach (var unit in units)
        {
            // Use the unit's original OrderIndex as the original chapter number for grouping
            var originalChapterNumber = unit.OrderIndex;
            var splitParts = Split(unit, currentIndex, originalChapterNumber);
            result.AddRange(splitParts);
            currentIndex += splitParts.Count;
        }

        return result;
    }

    private List<(string Html, string PlainText, int WordCount)> SplitHtmlAtParagraphs(string html, string chapterTitle)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml($"<div>{html}</div>");

        var root = doc.DocumentNode.FirstChild;
        var paragraphs = ExtractParagraphs(root);

        if (paragraphs.Count == 0)
        {
            var wordCount = HtmlCleaner.CountWords(root.InnerText);
            return [(html, root.InnerText.Trim(), wordCount)];
        }

        var parts = new List<(string Html, string PlainText, int WordCount)>();
        var currentHtml = new StringBuilder();
        var currentText = new StringBuilder();
        var currentWordCount = 0;

        foreach (var (paragraphHtml, paragraphText, paragraphWordCount) in paragraphs)
        {
            // If adding this paragraph would exceed the limit and we have content,
            // start a new part
            if (currentWordCount > 0 && currentWordCount + paragraphWordCount > _maxWordsPerPart)
            {
                parts.Add((currentHtml.ToString().Trim(), currentText.ToString().Trim(), currentWordCount));
                currentHtml.Clear();
                currentText.Clear();
                currentWordCount = 0;
            }

            currentHtml.Append(paragraphHtml);
            currentText.Append(paragraphText).Append(' ');
            currentWordCount += paragraphWordCount;
        }

        // Don't forget the last part
        if (currentWordCount > 0)
        {
            parts.Add((currentHtml.ToString().Trim(), currentText.ToString().Trim(), currentWordCount));
        }

        return parts;
    }

    private static List<(string Html, string PlainText, int WordCount)> ExtractParagraphs(HtmlNode root)
    {
        var result = new List<(string Html, string PlainText, int WordCount)>();
        var blockTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
            "blockquote", "pre", "ul", "ol", "li", "table", "tr",
            "section", "article", "aside", "header", "footer"
        };

        void ProcessNode(HtmlNode node)
        {
            foreach (var child in node.ChildNodes.ToList())
            {
                if (child.NodeType == HtmlNodeType.Element && blockTags.Contains(child.Name))
                {
                    var html = child.OuterHtml;
                    var text = child.InnerText.Trim();
                    var wordCount = HtmlCleaner.CountWords(text);

                    if (wordCount > 0)
                    {
                        result.Add((html, text, wordCount));
                    }
                }
                else if (child.NodeType == HtmlNodeType.Element)
                {
                    // Recurse into non-block elements (like spans, divs without block children)
                    ProcessNode(child);
                }
                else if (child.NodeType == HtmlNodeType.Text)
                {
                    var text = child.InnerText.Trim();
                    var wordCount = HtmlCleaner.CountWords(text);
                    if (wordCount > 0)
                    {
                        // Wrap loose text in a paragraph
                        result.Add(($"<p>{HtmlDocument.HtmlEncode(text)}</p>", text, wordCount));
                    }
                }
            }
        }

        ProcessNode(root);
        return result;
    }
}
