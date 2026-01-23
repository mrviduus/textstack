using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Extractors;

public sealed class TxtTextExtractor : ITextExtractor
{
    public SourceFormat SupportedFormat => SourceFormat.Txt;

    public Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        return PlainTextReader.ExtractAsync(request, SourceFormat.Txt, ct);
    }
}
