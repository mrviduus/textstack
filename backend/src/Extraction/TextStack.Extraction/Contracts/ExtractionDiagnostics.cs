using TextStack.Extraction.Enums;

namespace TextStack.Extraction.Contracts;

public sealed record ExtractionDiagnostics(
    TextSource TextSource,
    double? Confidence,
    IReadOnlyList<ExtractionWarning> Warnings
)
{
    public static ExtractionDiagnostics Empty => new(TextSource.None, null, []);

    public static ExtractionDiagnostics NativeText() => new(TextSource.NativeText, null, []);

    public static ExtractionDiagnostics Unsupported(string fileName) => new(
        TextSource.None,
        null,
        [new ExtractionWarning(ExtractionWarningCode.UnsupportedFormat, $"Format not supported for file: {fileName}")]
    );
}
