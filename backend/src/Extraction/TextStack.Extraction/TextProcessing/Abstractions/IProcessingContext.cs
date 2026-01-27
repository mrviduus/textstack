using TextStack.Extraction.TextProcessing.Configuration;

namespace TextStack.Extraction.TextProcessing.Abstractions;

/// <summary>
/// Processing context - passed through all processors.
/// </summary>
public interface IProcessingContext
{
    /// <summary>
    /// Content language (en, uk, etc).
    /// </summary>
    string Language { get; }

    /// <summary>
    /// Processing options.
    /// </summary>
    TextProcessingOptions Options { get; }
}
