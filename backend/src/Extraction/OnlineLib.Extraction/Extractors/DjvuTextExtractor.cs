using System.Diagnostics;
using System.Text;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Ocr;
using OnlineLib.Extraction.Services;
using OnlineLib.Extraction.Utilities;
using SkiaSharp;

namespace OnlineLib.Extraction.Extractors;

/// <summary>
/// Extracts text from DJVU files using djvutxt (DjVuLibre).
/// Falls back to OCR if djvutxt is unavailable and OCR is enabled.
/// Requires DjVuLibre to be installed on the system.
/// </summary>
public sealed class DjvuTextExtractor : ITextExtractor
{
    private readonly ExtractionOptions _options;
    private readonly IOcrEngine? _ocrEngine;
    private readonly string _djvutxtPath;

    public DjvuTextExtractor() : this(ExtractionOptions.Default, null, "djvutxt")
    {
    }

    public DjvuTextExtractor(ExtractionOptions options, IOcrEngine? ocrEngine, string djvutxtPath = "djvutxt")
    {
        _options = options ?? ExtractionOptions.Default;
        _ocrEngine = ocrEngine;
        _djvutxtPath = djvutxtPath;
    }

    public SourceFormat SupportedFormat => SourceFormat.Djvu;

    public async Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();
        string? tempFile = null;

        try
        {
            // Save stream to temp file (djvutxt requires file path)
            tempFile = Path.GetTempFileName() + ".djvu";
            await using (var fs = File.Create(tempFile))
            {
                await request.Content.CopyToAsync(fs, ct);
            }

            ct.ThrowIfCancellationRequested();

            // Try native text extraction with djvutxt
            var (text, nativeSuccess) = await TryExtractNativeTextAsync(tempFile, warnings, ct);

            if (nativeSuccess && !string.IsNullOrWhiteSpace(text))
            {
                var units = SplitIntoPages(text);

                // Split long pages into smaller parts (consistent with EPUB/FB2/PDF)
                var splitter = new ChapterSplitter(request.Options.MaxWordsPerPart);
                var splitUnits = splitter.SplitAll(units);

                // Extract cover (first page as image)
                var (cover, mime) = await TryExtractCoverAsync(tempFile, warnings, ct);

                var metadata = new ExtractionMetadata(
                    TextProcessingUtils.ExtractTitleFromFileName(request.FileName), null, null, null, cover, mime);
                var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

                return new ExtractionResult(SourceFormat.Djvu, metadata, splitUnits, diagnostics);
            }

            // Native extraction yielded no text - try OCR if enabled
            if (_options.EnableOcrFallback && _ocrEngine is not null)
            {
                return await ExtractWithOcrAsync(tempFile, request.FileName, request.Options.MaxWordsPerPart, warnings, ct);
            }

            // No text and no OCR fallback - still try to extract cover
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "DJVU contains no extractable text layer"));

            var (coverImage, coverMimeType) = await TryExtractCoverAsync(tempFile, warnings, ct);

            return new ExtractionResult(
                SourceFormat.Djvu,
                new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(request.FileName), null, null, null, coverImage, coverMimeType),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"Failed to process DJVU: {ex.Message}"));

            return new ExtractionResult(
                SourceFormat.Djvu,
                new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(request.FileName), null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }
        finally
        {
            if (tempFile is not null && File.Exists(tempFile))
            {
                try { File.Delete(tempFile); }
                catch { /* ignore cleanup errors */ }
            }
        }
    }

    private async Task<(string text, bool success)> TryExtractNativeTextAsync(
        string filePath,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = _djvutxtPath,
                    Arguments = $"\"{filePath}\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();

            var outputTask = process.StandardOutput.ReadToEndAsync(ct);
            var errorTask = process.StandardError.ReadToEndAsync(ct);

            await process.WaitForExitAsync(ct);

            var output = await outputTask;
            var error = await errorTask;

            if (process.ExitCode != 0)
            {
                if (!string.IsNullOrWhiteSpace(error))
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.PartialExtraction,
                        $"djvutxt warning: {error.Trim()}"));
                }
                return (string.Empty, false);
            }

            return (TextProcessingUtils.NormalizeText(output), true);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.PartialExtraction,
                $"djvutxt not available: {ex.Message}"));
            return (string.Empty, false);
        }
    }

    private static async Task<(byte[]? coverImage, string? coverMimeType)> TryExtractCoverAsync(
        string filePath,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        string? tempPpm = null;
        try
        {
            tempPpm = Path.GetTempFileName() + ".ppm";

            // Use ddjvu to render first page as PPM
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ddjvu",
                    Arguments = $"-format=ppm -page=1 -size=800x1200 \"{filePath}\" \"{tempPpm}\"",
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();
            await process.WaitForExitAsync(ct);

            if (process.ExitCode != 0 || !File.Exists(tempPpm))
            {
                return (null, null);
            }

            // Convert PPM to PNG using SkiaSharp
            var ppmBytes = await File.ReadAllBytesAsync(tempPpm, ct);
            using var bitmap = LoadPpmImage(ppmBytes);
            if (bitmap == null)
            {
                return (null, null);
            }

            using var pngStream = new MemoryStream();
            bitmap.Encode(pngStream, SKEncodedImageFormat.Png, 100);
            return (pngStream.ToArray(), "image/png");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to extract cover: {ex.Message}"));
            return (null, null);
        }
        finally
        {
            if (tempPpm != null && File.Exists(tempPpm))
            {
                try { File.Delete(tempPpm); }
                catch { /* ignore */ }
            }
        }
    }

    private static SKBitmap? LoadPpmImage(byte[] ppmData)
    {
        // PPM format: P6 (binary RGB)
        // Header: P6\n<width> <height>\n<maxval>\n<binary data>
        var headerEnd = 0;
        var headerLines = 0;
        var width = 0;
        var height = 0;

        // Parse header
        for (var i = 0; i < ppmData.Length - 1 && headerLines < 3; i++)
        {
            if (ppmData[i] == '\n')
            {
                var line = Encoding.ASCII.GetString(ppmData, headerEnd, i - headerEnd).Trim();
                headerEnd = i + 1;

                // Skip comments
                if (line.StartsWith('#'))
                    continue;

                headerLines++;
                if (headerLines == 1)
                {
                    if (line != "P6")
                        return null;
                }
                else if (headerLines == 2)
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2)
                    {
                        width = int.Parse(parts[0]);
                        height = int.Parse(parts[1]);
                    }
                }
            }
        }

        if (width == 0 || height == 0)
            return null;

        // Create bitmap from RGB data
        var bitmap = new SKBitmap(width, height, SKColorType.Rgba8888, SKAlphaType.Opaque);
        var pixels = bitmap.GetPixels();

        unsafe
        {
            var pixelPtr = (byte*)pixels.ToPointer();
            var dataIndex = headerEnd;
            for (var y = 0; y < height && dataIndex < ppmData.Length - 2; y++)
            {
                for (var x = 0; x < width && dataIndex < ppmData.Length - 2; x++)
                {
                    var r = ppmData[dataIndex++];
                    var g = ppmData[dataIndex++];
                    var b = ppmData[dataIndex++];

                    var pixelIndex = (y * width + x) * 4;
                    pixelPtr[pixelIndex] = r;
                    pixelPtr[pixelIndex + 1] = g;
                    pixelPtr[pixelIndex + 2] = b;
                    pixelPtr[pixelIndex + 3] = 255; // Alpha
                }
            }
        }

        return bitmap;
    }

    private async Task<ExtractionResult> ExtractWithOcrAsync(
        string filePath,
        string fileName,
        int maxWordsPerPart,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        var units = new List<ContentUnit>();
        var confidences = new List<double>();

        // Get page count
        var pageCount = await GetPageCountAsync(filePath, ct);

        if (pageCount <= 0)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                "Could not determine page count for DJVU file"));

            return new ExtractionResult(
                SourceFormat.Djvu,
                new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(fileName), null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Check page limit
        if (pageCount > _options.MaxPagesForOcr)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.OcrPageLimitExceeded,
                $"DJVU has {pageCount} pages, exceeding OCR limit of {_options.MaxPagesForOcr}"));
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "DJVU contains no extractable text layer"));

            return new ExtractionResult(
                SourceFormat.Djvu,
                new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(fileName), null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Extract and OCR each page
        for (var i = 1; i <= pageCount; i++)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                using var imageStream = await RenderPageToImageAsync(filePath, i, ct);

                var ocrResult = await _ocrEngine!.RecognizeAsync(
                    imageStream, _options.OcrLanguage, ct);

                var normalized = TextProcessingUtils.NormalizeText(ocrResult.Text);
                var html = TextProcessingUtils.PlainTextToHtml(normalized);

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Page,
                    Title: null,
                    Html: html,
                    PlainText: normalized,
                    OrderIndex: i - 1,
                    WordCount: TextProcessingUtils.CountWords(normalized)
                ));

                if (ocrResult.Confidence.HasValue)
                    confidences.Add(ocrResult.Confidence.Value);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.OcrFailed,
                    $"OCR failed for page {i}: {ex.Message}"));

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Page,
                    Title: null,
                    Html: string.Empty,
                    PlainText: string.Empty,
                    OrderIndex: i - 1,
                    WordCount: 0
                ));
            }
        }

        var hasOcrText = units.Any(u => !string.IsNullOrWhiteSpace(u.PlainText));
        var textSource = hasOcrText ? TextSource.Ocr : TextSource.None;
        var avgConfidence = confidences.Count > 0 ? confidences.Average() : (double?)null;

        if (!hasOcrText)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "OCR could not extract any text from the DJVU"));
        }

        // Split long pages into smaller parts (consistent with EPUB/FB2/PDF)
        var splitter = new ChapterSplitter(maxWordsPerPart);
        var splitUnits = splitter.SplitAll(units);

        var metadata = new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(fileName), null, null, null);
        var diagnostics = new ExtractionDiagnostics(textSource, avgConfidence, warnings);

        return new ExtractionResult(SourceFormat.Djvu, metadata, splitUnits, diagnostics);
    }

    private async Task<int> GetPageCountAsync(string filePath, CancellationToken ct)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "djvused",
                    Arguments = $"-e 'n' \"{filePath}\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();
            var output = await process.StandardOutput.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);

            if (int.TryParse(output.Trim(), out var count))
                return count;

            return 0;
        }
        catch
        {
            return 0;
        }
    }

    private static async Task<MemoryStream> RenderPageToImageAsync(
        string filePath, int pageNumber, CancellationToken ct)
    {
        // Use ddjvu to render page to PNM, then convert to PNG
        var tempPnm = Path.GetTempFileName() + ".pnm";
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ddjvu",
                    Arguments = $"-format=pnm -page={pageNumber} -size=2000x3000 \"{filePath}\" \"{tempPnm}\"",
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();
            await process.WaitForExitAsync(ct);

            if (process.ExitCode != 0 || !File.Exists(tempPnm))
            {
                throw new InvalidOperationException($"ddjvu failed for page {pageNumber}");
            }

            // Read the PNM file into a memory stream
            var ms = new MemoryStream();
            await using (var fs = File.OpenRead(tempPnm))
            {
                await fs.CopyToAsync(ms, ct);
            }
            ms.Position = 0;
            return ms;
        }
        finally
        {
            if (File.Exists(tempPnm))
            {
                try { File.Delete(tempPnm); }
                catch { /* ignore */ }
            }
        }
    }

    private static IReadOnlyList<ContentUnit> SplitIntoPages(string text)
    {
        // DJVU native text doesn't have clear page boundaries from djvutxt
        // Return as single unit if we can't detect page breaks
        var normalized = TextProcessingUtils.NormalizeText(text);

        if (string.IsNullOrWhiteSpace(normalized))
            return [];

        // Simple heuristic: split on form feed characters if present
        var pages = normalized.Split('\f', StringSplitOptions.RemoveEmptyEntries);

        if (pages.Length <= 1)
        {
            return
            [
                new ContentUnit(
                    Type: ContentUnitType.Page,
                    Title: null,
                    Html: TextProcessingUtils.PlainTextToHtml(normalized),
                    PlainText: normalized,
                    OrderIndex: 0,
                    WordCount: TextProcessingUtils.CountWords(normalized)
                )
            ];
        }

        return pages
            .Select((pageText, index) => new ContentUnit(
                Type: ContentUnitType.Page,
                Title: null,
                Html: TextProcessingUtils.PlainTextToHtml(pageText.Trim()),
                PlainText: pageText.Trim(),
                OrderIndex: index,
                WordCount: TextProcessingUtils.CountWords(pageText)
            ))
            .ToList();
    }

}
