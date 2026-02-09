using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.DocumentLayoutAnalysis.PageSegmenter;
using UglyToad.PdfPig.DocumentLayoutAnalysis.WordExtractor;

namespace TextStack.Extraction.Extractors.Pdf;

/// <summary>
/// Extracts structured text (paragraphs, headings, bold/italic) from a single PDF page.
/// Uses RecursiveXYCut for column detection and reading order.
/// </summary>
public static class PdfPageTextExtractor
{
    private const double LineYTolerance = 3.0;
    private const double ParagraphGapMultiplier = 1.5;

    public static List<PdfTextElement> ExtractPage(Page page)
    {
        var words = page.GetWords(NearestNeighbourWordExtractor.Instance).ToList();
        if (words.Count == 0)
            return [];

        // Use RecursiveXYCut to segment page into reading-order blocks
        var blocks = RecursiveXYCut.Instance.GetBlocks(words);

        // Determine heading font size threshold: largest font on page
        var maxFontSize = words.Max(w => w.Letters.Count > 0 ? w.Letters.Max(l => l.FontSize) : 0);
        var headingThreshold = maxFontSize * 0.9;

        var elements = new List<PdfTextElement>();

        foreach (var block in blocks)
        {
            var blockWords = block.TextLines
                .SelectMany(l => l.Words)
                .ToList();

            if (blockWords.Count == 0)
                continue;

            // Group words into lines by Y-coord proximity
            var lines = GroupWordsIntoLines(blockWords);

            // Group lines into paragraphs by vertical gap
            var paragraphs = GroupLinesIntoParagraphs(lines);

            foreach (var paragraph in paragraphs)
            {
                var allWords = paragraph.SelectMany(l => l).ToList();
                if (allWords.Count == 0)
                    continue;

                var text = string.Join(" ", allWords.Select(w => w.Text)).Trim();
                if (string.IsNullOrWhiteSpace(text))
                    continue;

                // Detect style from the first word's font name
                var fontName = GetDominantFontName(allWords);
                var isBold = fontName.Contains("Bold", StringComparison.OrdinalIgnoreCase);
                var isItalic = fontName.Contains("Italic", StringComparison.OrdinalIgnoreCase)
                               || fontName.Contains("Oblique", StringComparison.OrdinalIgnoreCase);

                // Detect heading: first line of page with largest font size
                var avgFontSize = allWords
                    .SelectMany(w => w.Letters)
                    .Select(l => l.FontSize)
                    .DefaultIfEmpty(0)
                    .Average();

                var isHeading = avgFontSize >= headingThreshold && text.Length < 200;

                var yPosition = allWords
                    .Select(w => w.BoundingBox.Bottom)
                    .Average();

                elements.Add(new PdfTextElement(
                    isHeading ? TextElementType.Heading : TextElementType.Paragraph,
                    text,
                    isBold,
                    isItalic,
                    yPosition));
            }
        }

        return elements;
    }

    private static List<List<Word>> GroupWordsIntoLines(List<Word> words)
    {
        if (words.Count == 0)
            return [];

        // Sort by Y descending (top of page first), then X ascending
        var sorted = words.OrderByDescending(w => w.BoundingBox.Bottom).ThenBy(w => w.BoundingBox.Left).ToList();

        var lines = new List<List<Word>>();
        var currentLine = new List<Word> { sorted[0] };
        var currentY = sorted[0].BoundingBox.Bottom;

        for (var i = 1; i < sorted.Count; i++)
        {
            var word = sorted[i];
            if (Math.Abs(word.BoundingBox.Bottom - currentY) <= LineYTolerance)
            {
                currentLine.Add(word);
            }
            else
            {
                lines.Add(currentLine.OrderBy(w => w.BoundingBox.Left).ToList());
                currentLine = [word];
                currentY = word.BoundingBox.Bottom;
            }
        }

        lines.Add(currentLine.OrderBy(w => w.BoundingBox.Left).ToList());
        return lines;
    }

    private static List<List<List<Word>>> GroupLinesIntoParagraphs(List<List<Word>> lines)
    {
        if (lines.Count == 0)
            return [];

        // Estimate typical line height
        var lineHeights = new List<double>();
        for (var i = 1; i < lines.Count; i++)
        {
            var prevY = lines[i - 1].Average(w => w.BoundingBox.Bottom);
            var currY = lines[i].Average(w => w.BoundingBox.Bottom);
            var gap = Math.Abs(prevY - currY);
            if (gap > 0)
                lineHeights.Add(gap);
        }

        var avgLineHeight = lineHeights.Count > 0 ? lineHeights.Average() : 12.0;
        var paragraphGapThreshold = avgLineHeight * ParagraphGapMultiplier;

        var paragraphs = new List<List<List<Word>>>();
        var currentParagraph = new List<List<Word>> { lines[0] };

        for (var i = 1; i < lines.Count; i++)
        {
            var prevY = lines[i - 1].Average(w => w.BoundingBox.Bottom);
            var currY = lines[i].Average(w => w.BoundingBox.Bottom);
            var gap = Math.Abs(prevY - currY);

            if (gap > paragraphGapThreshold)
            {
                paragraphs.Add(currentParagraph);
                currentParagraph = [lines[i]];
            }
            else
            {
                currentParagraph.Add(lines[i]);
            }
        }

        paragraphs.Add(currentParagraph);
        return paragraphs;
    }

    private static string GetDominantFontName(List<Word> words)
    {
        var fontCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var word in words)
        {
            foreach (var letter in word.Letters)
            {
                var name = letter.FontName ?? "";
                fontCounts[name] = fontCounts.GetValueOrDefault(name) + 1;
            }
        }

        return fontCounts.Count > 0
            ? fontCounts.MaxBy(kv => kv.Value).Key
            : "";
    }
}
