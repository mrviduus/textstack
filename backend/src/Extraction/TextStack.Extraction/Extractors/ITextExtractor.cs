using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;

namespace TextStack.Extraction.Extractors;

public interface ITextExtractor
{
    SourceFormat SupportedFormat { get; }
    Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default);
}
