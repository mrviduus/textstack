using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.TextProcessing.Configuration;

namespace TextStack.Extraction.TextProcessing.Pipeline;

/// <summary>
/// Processing context implementation.
/// </summary>
public class ProcessingContext : IProcessingContext
{
    public string Language { get; }
    public TextProcessingOptions Options { get; }

    public ProcessingContext(string? language = null, TextProcessingOptions? options = null)
    {
        Language = language ?? "en";
        Options = options ?? new TextProcessingOptions();
    }
}
