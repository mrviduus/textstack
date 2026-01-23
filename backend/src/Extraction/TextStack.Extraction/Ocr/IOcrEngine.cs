namespace TextStack.Extraction.Ocr;

/// <summary>
/// OCR engine abstraction for text recognition from images.
/// </summary>
public interface IOcrEngine
{
    /// <summary>
    /// Recognizes text from an image stream.
    /// </summary>
    /// <param name="image">Image stream (PNG, JPEG, TIFF, etc.)</param>
    /// <param name="language">Language code (e.g., "eng", "ukr")</param>
    /// <param name="ct">Cancellation token</param>
    /// <returns>OCR result with text and optional confidence</returns>
    Task<OcrPageResult> RecognizeAsync(Stream image, string language, CancellationToken ct = default);
}
