using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Registry;

public interface IExtractorRegistry
{
    SourceFormat DetectFormat(ExtractionRequest request);
    ITextExtractor Resolve(ExtractionRequest request);
}
