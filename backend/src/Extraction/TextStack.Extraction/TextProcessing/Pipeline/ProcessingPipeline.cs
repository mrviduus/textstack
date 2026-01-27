using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Pipeline;

/// <summary>
/// Executes processors sequentially.
/// </summary>
public class ProcessingPipeline : IProcessingPipeline
{
    private static readonly Regex TagRegex = new(@"<[^>]+>", RegexOptions.Compiled);
    private static readonly Regex WhitespaceRegex = new(@"\s+", RegexOptions.Compiled);

    private readonly IReadOnlyList<ITextProcessor> _processors;

    public ProcessingPipeline(IEnumerable<ITextProcessor> processors)
    {
        _processors = processors.OrderBy(p => p.Order).ToList();
    }

    public (string Html, string PlainText) Process(string html, IProcessingContext context)
    {
        foreach (var processor in _processors)
        {
            html = processor.Process(html, context);
        }

        var plainText = ExtractPlainText(html);
        return (html, plainText);
    }

    private static string ExtractPlainText(string html)
    {
        // Simple approach: strip tags and decode entities
        // Avoids HAP which might cause issues on ARM64
        var text = TagRegex.Replace(html, " ");
        text = WebUtility.HtmlDecode(text);
        text = WhitespaceRegex.Replace(text, " ");
        return text.Trim();
    }
}
