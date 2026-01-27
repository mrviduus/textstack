namespace TextStack.Extraction.TextProcessing.Abstractions;

/// <summary>
/// Text processor - one step in the processing pipeline.
/// </summary>
public interface ITextProcessor
{
    /// <summary>
    /// Unique name for logging and debugging.
    /// </summary>
    string Name { get; }

    /// <summary>
    /// Execution order (lower = earlier).
    /// </summary>
    int Order { get; }

    /// <summary>
    /// Process input HTML and return result.
    /// </summary>
    string Process(string input, IProcessingContext context);
}
