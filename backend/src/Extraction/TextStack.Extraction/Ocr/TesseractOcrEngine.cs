using Tesseract;

namespace TextStack.Extraction.Ocr;

/// <summary>
/// Tesseract-based OCR engine implementation.
/// Requires Tesseract native libraries and language data files.
/// </summary>
public sealed class TesseractOcrEngine : IOcrEngine, IDisposable
{
    private readonly string _tessDataPath;
    private readonly Dictionary<string, TesseractEngine> _engines = new();
    private readonly object _lock = new();
    private bool _disposed;

    /// <summary>
    /// Creates a new TesseractOcrEngine.
    /// </summary>
    /// <param name="tessDataPath">Path to tessdata folder containing language files</param>
    public TesseractOcrEngine(string tessDataPath)
    {
        _tessDataPath = tessDataPath ?? throw new ArgumentNullException(nameof(tessDataPath));
    }

    public Task<OcrPageResult> RecognizeAsync(Stream image, string language, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(image);
        language ??= "eng";

        ct.ThrowIfCancellationRequested();

        var engine = GetOrCreateEngine(language);

        using var ms = new MemoryStream();
        image.CopyTo(ms);
        var imageBytes = ms.ToArray();

        ct.ThrowIfCancellationRequested();

        using var pix = Pix.LoadFromMemory(imageBytes);
        using var page = engine.Process(pix);

        var text = page.GetText()?.Trim() ?? string.Empty;
        var confidence = page.GetMeanConfidence();

        return Task.FromResult(new OcrPageResult(text, confidence));
    }

    private TesseractEngine GetOrCreateEngine(string language)
    {
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            if (_engines.TryGetValue(language, out var existing))
                return existing;

            var engine = new TesseractEngine(_tessDataPath, language, EngineMode.Default);
            _engines[language] = engine;
            return engine;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;

        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;

            foreach (var engine in _engines.Values)
            {
                engine.Dispose();
            }
            _engines.Clear();
        }
    }
}
