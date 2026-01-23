namespace TextStack.Extraction.Ocr;

/// <summary>
/// Result of OCR processing for a single page/image.
/// </summary>
public sealed record OcrPageResult(
    /// <summary>
    /// Extracted text (never null, may be empty).
    /// </summary>
    string Text,

    /// <summary>
    /// Confidence score (0.0 to 1.0). Null if not available.
    /// </summary>
    double? Confidence
);
