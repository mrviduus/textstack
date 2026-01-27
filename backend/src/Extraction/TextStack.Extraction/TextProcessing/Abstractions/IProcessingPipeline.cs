namespace TextStack.Extraction.TextProcessing.Abstractions;

/// <summary>
/// Pipeline - executes processors sequentially.
/// </summary>
public interface IProcessingPipeline
{
    /// <summary>
    /// Process HTML and return result.
    /// </summary>
    (string Html, string PlainText) Process(string html, IProcessingContext context);
}
