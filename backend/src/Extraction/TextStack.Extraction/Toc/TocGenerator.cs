using System.Text.RegularExpressions;
using HtmlAgilityPack;

namespace TextStack.Extraction.Toc;

/// <summary>
/// Generates hierarchical table of contents from HTML headings.
/// Injects anchor IDs into headings for navigation.
/// </summary>
public static class TocGenerator
{
    /// <summary>
    /// Generate ToC entries from a list of chapters.
    /// </summary>
    public static List<TocEntry> GenerateToc(IReadOnlyList<(int ChapterNumber, string Html)> chapters)
    {
        var entries = new List<TocEntry>();

        foreach (var (chapterNumber, html) in chapters)
        {
            var chapterEntries = ExtractHeadings(chapterNumber, html);
            entries.AddRange(chapterEntries);
        }

        return BuildHierarchy(entries);
    }

    /// <summary>
    /// Inject anchor IDs into headings in HTML.
    /// Returns modified HTML with id attributes on h1-h6 tags.
    /// </summary>
    public static string InjectAnchorIds(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var headingIndex = 0;
        var headings = doc.DocumentNode.SelectNodes("//h1|//h2|//h3|//h4|//h5|//h6");

        if (headings == null)
            return html;

        foreach (var heading in headings)
        {
            // Skip if already has id
            if (!string.IsNullOrEmpty(heading.GetAttributeValue("id", null)))
                continue;

            var text = heading.InnerText.Trim();
            var slug = GenerateSlug(text);

            if (string.IsNullOrEmpty(slug))
                slug = $"h{headingIndex}";

            var id = $"ch{chapterNumber}-{slug}";
            heading.SetAttributeValue("id", id);
            headingIndex++;
        }

        return doc.DocumentNode.InnerHtml;
    }

    private static List<TocEntry> ExtractHeadings(int chapterNumber, string html)
    {
        var entries = new List<TocEntry>();

        if (string.IsNullOrEmpty(html))
            return entries;

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var headings = doc.DocumentNode.SelectNodes("//h1|//h2|//h3");

        if (headings == null)
            return entries;

        foreach (var heading in headings)
        {
            var level = int.Parse(heading.Name.Substring(1));
            var title = CleanTitle(heading.InnerText);
            var id = heading.GetAttributeValue("id", null);

            if (string.IsNullOrWhiteSpace(title))
                continue;

            entries.Add(new TocEntry(
                Title: title,
                ChapterNumber: chapterNumber,
                Anchor: id != null ? $"#{id}" : null,
                Level: level,
                Children: null
            ));
        }

        return entries;
    }

    private static List<TocEntry> BuildHierarchy(List<TocEntry> flatEntries)
    {
        if (flatEntries.Count == 0)
            return [];

        var result = new List<TocEntry>();
        var stack = new Stack<(TocEntry Entry, List<TocEntry> Children)>();

        foreach (var entry in flatEntries)
        {
            var children = new List<TocEntry>();
            var entryWithChildren = entry with { Children = children };

            // Pop entries that are same level or higher (lower number = higher in hierarchy)
            while (stack.Count > 0 && stack.Peek().Entry.Level >= entry.Level)
            {
                stack.Pop();
            }

            if (stack.Count == 0)
            {
                // Top-level entry
                result.Add(entryWithChildren);
            }
            else
            {
                // Add as child of current parent
                stack.Peek().Children.Add(entryWithChildren);
            }

            stack.Push((entryWithChildren, children));
        }

        return result;
    }

    private static string CleanTitle(string title)
    {
        if (string.IsNullOrEmpty(title))
            return title;

        // Remove extra whitespace
        title = WhitespaceRegex().Replace(title, " ").Trim();

        // Decode HTML entities
        title = System.Net.WebUtility.HtmlDecode(title);

        return title;
    }

    private static string GenerateSlug(string text)
    {
        if (string.IsNullOrEmpty(text))
            return string.Empty;

        // Decode HTML entities first
        text = System.Net.WebUtility.HtmlDecode(text);

        // Convert to lowercase
        text = text.ToLowerInvariant();

        // Replace spaces with hyphens
        text = text.Replace(' ', '-');

        // Remove non-alphanumeric except hyphens
        text = SlugCleanRegex().Replace(text, "");

        // Collapse multiple hyphens
        text = MultipleHyphensRegex().Replace(text, "-");

        // Trim hyphens
        text = text.Trim('-');

        // Limit length
        if (text.Length > 50)
            text = text.Substring(0, 50).TrimEnd('-');

        return text;
    }

    private static readonly Regex WhitespaceRegexInstance = new(@"\s+", RegexOptions.Compiled);
    private static Regex WhitespaceRegex() => WhitespaceRegexInstance;

    private static readonly Regex SlugCleanRegexInstance = new(@"[^a-z0-9\-]", RegexOptions.Compiled);
    private static Regex SlugCleanRegex() => SlugCleanRegexInstance;

    private static readonly Regex MultipleHyphensRegexInstance = new(@"-{2,}", RegexOptions.Compiled);
    private static Regex MultipleHyphensRegex() => MultipleHyphensRegexInstance;
}
