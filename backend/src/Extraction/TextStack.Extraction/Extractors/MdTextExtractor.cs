using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Extractors;

public sealed class MdTextExtractor : ITextExtractor
{
    public SourceFormat SupportedFormat => SourceFormat.Md;

    public Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        return PlainTextReader.ExtractAsync(request, SourceFormat.Md, ct);
    }
}
