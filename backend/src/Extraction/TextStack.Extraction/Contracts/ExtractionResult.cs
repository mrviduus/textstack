using TextStack.Extraction.Enums;
using TextStack.Extraction.Toc;

namespace TextStack.Extraction.Contracts;

public sealed record ExtractionResult(
    SourceFormat SourceFormat,
    ExtractionMetadata Metadata,
    IReadOnlyList<ContentUnit> Units,
    IReadOnlyList<ExtractedImage> Images,
    ExtractionDiagnostics Diagnostics,
    IReadOnlyList<TocEntry>? Toc = null
)
{
    public static ExtractionResult Unsupported(string fileName) => new(
        SourceFormat.Unknown,
        new ExtractionMetadata(null, null, null, null),
        [],
        [],
        ExtractionDiagnostics.Unsupported(fileName),
        null
    );
}
