using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Normalizes whitespace: collapses multiple spaces, normalizes line breaks.
/// </summary>
public class WhitespaceProcessor : ITextProcessor
{
    public string Name => "Whitespace";
    public int Order => 100;

    private static readonly Regex TrailingWhitespaceRegex = new(@"[ \t]+\n", RegexOptions.Compiled);
    private static readonly Regex MultipleBlankLinesRegex = new(@"\n{3,}", RegexOptions.Compiled);
    private static readonly Regex MultipleSpacesRegex = new(@"[ \t]{2,}", RegexOptions.Compiled);
    private static readonly Regex SpaceBeforeCloseTagRegex = new(@"\s+</(\w+)>", RegexOptions.Compiled);
    private static readonly Regex SpaceAfterOpenTagRegex = new(@"<(\w+[^>]*)>\s+", RegexOptions.Compiled);
    private static readonly Regex SpaceBeforePunctuationRegex = new(@"\s+([.,;:!?])", RegexOptions.Compiled);

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        var html = input;

        // 1. Normalize line endings to \n
        html = html.Replace("\r\n", "\n").Replace("\r", "\n");

        // 2. Remove trailing whitespace on each line
        html = TrailingWhitespaceRegex.Replace(html, "\n");

        // 3. Collapse multiple blank lines to single
        html = MultipleBlankLinesRegex.Replace(html, "\n\n");

        // 4. Collapse multiple spaces (but not in pre/code tags)
        html = MultipleSpacesRegex.Replace(html, " ");

        // 5. Remove spaces around tags (but preserve nbsp)
        html = SpaceBeforeCloseTagRegex.Replace(html, "</$1>");
        html = SpaceAfterOpenTagRegex.Replace(html, "<$1>");

        // 6. Normalize space before punctuation
        html = SpaceBeforePunctuationRegex.Replace(html, "$1");

        return html.Trim();
    }
}
