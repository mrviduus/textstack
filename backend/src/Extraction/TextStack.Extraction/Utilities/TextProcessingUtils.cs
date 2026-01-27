using System.Text.RegularExpressions;

namespace TextStack.Extraction.Utilities;

/// <summary>
/// Shared text processing utilities used by all text extractors.
/// </summary>
public static class TextProcessingUtils
{
    /// <summary>
    /// Normalizes text by converting line endings to LF, trimming trailing whitespace,
    /// and collapsing multiple blank lines.
    /// </summary>
    public static string NormalizeText(string text)
    {
        if (string.IsNullOrEmpty(text))
            return string.Empty;

        text = text.Replace("\r\n", "\n").Replace("\r", "\n");

        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            lines[i] = lines[i].TrimEnd();
        }

        text = string.Join("\n", lines);
        text = MultipleNewlinesRegex().Replace(text, "\n\n");

        return text.Trim();
    }

    /// <summary>
    /// Converts plain text to HTML by escaping entities and wrapping paragraphs.
    /// </summary>
    public static string PlainTextToHtml(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        var escaped = System.Net.WebUtility.HtmlEncode(text);
        var paragraphs = escaped.Split(["\n\n"], StringSplitOptions.RemoveEmptyEntries);
        var htmlParagraphs = paragraphs
            .Select(p => $"<p>{p.Replace("\n", "<br/>")}</p>");

        return string.Join("\n", htmlParagraphs);
    }

    /// <summary>
    /// Counts words in text by splitting on whitespace.
    /// </summary>
    public static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return 0;

        return text.Split([' ', '\t', '\n'], StringSplitOptions.RemoveEmptyEntries).Length;
    }

    /// <summary>
    /// Extracts a title from a filename by removing the extension.
    /// </summary>
    public static string? ExtractTitleFromFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
            return null;

        var name = Path.GetFileNameWithoutExtension(fileName);
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    private static readonly Regex MultipleNewlinesRegexInstance = new(@"\n{3,}", RegexOptions.Compiled);
    private static Regex MultipleNewlinesRegex() => MultipleNewlinesRegexInstance;
}
