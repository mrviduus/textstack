namespace TextStack.Extraction.Contracts;

/// <summary>
/// Configuration options for the extraction pipeline.
/// </summary>
public sealed class ExtractionOptions
{
    /// <summary>
    /// Whether to enable OCR fallback for image-only documents.
    /// Default: false (OCR disabled).
    /// </summary>
    public bool EnableOcrFallback { get; init; }

    /// <summary>
    /// Maximum number of pages to OCR. Documents exceeding this limit
    /// will not be OCR'd and will return TextSource.None with a warning.
    /// Default: 50 pages.
    /// </summary>
    public int MaxPagesForOcr { get; init; } = 50;

    /// <summary>
    /// OCR language code (e.g., "eng", "ukr", "rus").
    /// Default: "eng" (English).
    /// </summary>
    public string OcrLanguage { get; init; } = "eng";

    /// <summary>
    /// Default options with OCR disabled.
    /// </summary>
    public static ExtractionOptions Default { get; } = new();
}
