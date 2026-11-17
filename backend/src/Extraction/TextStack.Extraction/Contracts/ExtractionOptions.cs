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
    /// Whether the PDF extractor should extract embedded inline images and
    /// composite SMask figures into the reading flow (ADR-012 S5a).
    /// Default: false — user-uploaded PDFs render pixel-perfect via PDF.js and
    /// "Ask this book" RAG re-renders pages via vision, so extracted chapter
    /// <c>&lt;img&gt;</c> are dead weight. Only tests set
    /// this true since the admin-catalog reflow path retired (M6). The rendered cover is unaffected
    /// (always produced via <c>RenderFirstPageAsCover</c>). EPUB is unaffected.
    /// </summary>
    public bool ExtractInlineImages { get; init; }

    /// <summary>
    /// Default options with OCR disabled.
    /// </summary>
    public static ExtractionOptions Default { get; } = new();
}
