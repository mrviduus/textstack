using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;
using OnlineLib.Extraction.Ocr;
using OnlineLib.Extraction.Services;
using OnlineLib.Extraction.Utilities;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Rendering.Skia;
using UglyToad.PdfPig.Graphics.Colors;

namespace OnlineLib.Extraction.Extractors;

public sealed class PdfTextExtractor : ITextExtractor
{
    private readonly ExtractionOptions _options;
    private readonly IOcrEngine? _ocrEngine;

    public PdfTextExtractor() : this(ExtractionOptions.Default, null)
    {
    }

    public PdfTextExtractor(ExtractionOptions options, IOcrEngine? ocrEngine)
    {
        _options = options ?? ExtractionOptions.Default;
        _ocrEngine = ocrEngine;
    }

    public SourceFormat SupportedFormat => SourceFormat.Pdf;

    public async Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();
        var units = new List<ContentUnit>();
        string? title = null;
        string? authors = null;
        int totalPages = 0;

        PdfDocument? document = null;
        try
        {
            document = PdfDocument.Open(request.Content);

            title = GetMetadataValue(document.Information?.Title);
            authors = GetMetadataValue(document.Information?.Author);
            totalPages = document.NumberOfPages;

            for (var i = 0; i < document.NumberOfPages; i++)
            {
                if (ct.IsCancellationRequested)
                    break;

                try
                {
                    var page = document.GetPage(i + 1);
                    var text = ExtractPageText(page);
                    var normalized = TextProcessingUtils.NormalizeText(text);
                    var html = TextProcessingUtils.PlainTextToHtml(normalized);

                    units.Add(new ContentUnit(
                        Type: ContentUnitType.Page,
                        Title: $"Page {i + 1}",
                        Html: html,
                        PlainText: normalized,
                        OrderIndex: i,
                        WordCount: TextProcessingUtils.CountWords(normalized)
                    ));
                }
                catch (Exception ex)
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.PageParseError,
                        $"Failed to parse page {i + 1}: {ex.Message}"));

                    units.Add(new ContentUnit(
                        Type: ContentUnitType.Page,
                        Title: $"Page {i + 1}",
                        Html: null,
                        PlainText: string.Empty,
                        OrderIndex: i,
                        WordCount: 0
                    ));
                }
            }
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"Failed to parse PDF: {ex.Message}"));

            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(TextProcessingUtils.ExtractTitleFromFileName(request.FileName), null, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }
        finally
        {
            document?.Dispose();
        }

        ct.ThrowIfCancellationRequested();

        var hasText = units.Any(u => !string.IsNullOrWhiteSpace(u.PlainText));

        // If no native text and OCR is enabled, attempt OCR fallback
        if (!hasText && _options.EnableOcrFallback && _ocrEngine is not null)
        {
            return await ExtractWithOcrAsync(request, title, authors, totalPages, warnings, ct);
        }

        var textSource = hasText ? TextSource.NativeText : TextSource.None;

        if (!hasText)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "PDF contains no extractable text layer"));
        }

        // Extract cover (first page as image)
        byte[]? coverImage = null;
        string? coverMimeType = null;
        try
        {
            request.Content.Position = 0;
            using var coverDoc = PdfDocument.Open(request.Content, SkiaRenderingParsingOptions.Instance);
            coverDoc.AddSkiaPageFactory();
            using var pngStream = coverDoc.GetPageAsPng(1, scale: 1.0f);
            coverImage = pngStream.ToArray();
            coverMimeType = "image/png";
        }
        catch (Exception ex)
        {
            // Cover extraction is optional, don't fail on error
            // Get deepest inner exception message
            var innerEx = ex;
            while (innerEx.InnerException != null)
                innerEx = innerEx.InnerException;
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to extract cover: {innerEx.GetType().Name}: {innerEx.Message}"));
        }

        title ??= TextProcessingUtils.ExtractTitleFromFileName(request.FileName);

        // Split long pages into smaller parts (consistent with EPUB/FB2)
        var splitter = new ChapterSplitter(request.Options.MaxWordsPerPart);
        var splitUnits = splitter.SplitAll(units);

        var metadata = new ExtractionMetadata(title, authors, null, null, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(textSource, null, warnings);

        return new ExtractionResult(SourceFormat.Pdf, metadata, splitUnits, diagnostics);
    }

    private async Task<ExtractionResult> ExtractWithOcrAsync(
        ExtractionRequest request,
        string? title,
        string? authors,
        int totalPages,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        // Check page limit
        if (totalPages > _options.MaxPagesForOcr)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.OcrPageLimitExceeded,
                $"PDF has {totalPages} pages, exceeding OCR limit of {_options.MaxPagesForOcr}"));
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "PDF contains no extractable text layer"));

            title ??= TextProcessingUtils.ExtractTitleFromFileName(request.FileName);
            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(title, authors, null, null),
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        var units = new List<ContentUnit>();
        var confidences = new List<double>();

        // Re-open document for rendering with Skia parsing options
        request.Content.Position = 0;
        using var document = PdfDocument.Open(request.Content, SkiaRenderingParsingOptions.Instance);
        document.AddSkiaPageFactory();

        for (var i = 0; i < document.NumberOfPages; i++)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                var page = document.GetPage(i + 1);

                // Render page to image
                using var imageStream = RenderPageToImage(document, i + 1);

                // OCR the image
                var ocrResult = await _ocrEngine!.RecognizeAsync(
                    imageStream, _options.OcrLanguage, ct);

                var normalized = TextProcessingUtils.NormalizeText(ocrResult.Text);
                var html = TextProcessingUtils.PlainTextToHtml(normalized);

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Page,
                    Title: $"Page {i + 1}",
                    Html: html,
                    PlainText: normalized,
                    OrderIndex: i,
                    WordCount: TextProcessingUtils.CountWords(normalized)
                ));

                if (ocrResult.Confidence.HasValue)
                    confidences.Add(ocrResult.Confidence.Value);
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.OcrFailed,
                    $"OCR failed for page {i + 1}: {ex.Message}"));

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Page,
                    Title: $"Page {i + 1}",
                    Html: null,
                    PlainText: string.Empty,
                    OrderIndex: i,
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
                "OCR could not extract any text from the PDF"));
        }

        // Extract cover (first page as image)
        byte[]? coverImage = null;
        string? coverMimeType = null;
        try
        {
            using var pngStream = document.GetPageAsPng(1, scale: 1.0f);
            coverImage = pngStream.ToArray();
            coverMimeType = "image/png";
        }
        catch (Exception ex)
        {
            // Cover extraction is optional
            var innerMsg = ex.InnerException?.Message ?? ex.Message;
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to extract cover: {innerMsg}"));
        }

        title ??= TextProcessingUtils.ExtractTitleFromFileName(request.FileName);

        // Split long pages into smaller parts (consistent with EPUB/FB2)
        var splitter = new ChapterSplitter(request.Options.MaxWordsPerPart);
        var splitUnits = splitter.SplitAll(units);

        var metadata = new ExtractionMetadata(title, authors, null, null, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(textSource, avgConfidence, warnings);

        return new ExtractionResult(SourceFormat.Pdf, metadata, splitUnits, diagnostics);
    }

    private static MemoryStream RenderPageToImage(PdfDocument document, int pageNumber)
    {
        // Use PdfPig's Skia extension method to render page to PNG (factory already added)
        // Scale 1.5 for reasonable OCR quality
        using var pngStream = document.GetPageAsPng(pageNumber, scale: 1.5f);

        var ms = new MemoryStream();
        pngStream.WriteTo(ms);
        ms.Position = 0;
        return ms;
    }

    private static string ExtractPageText(Page page)
    {
        return page.Text;
    }

    private static string? GetMetadataValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        return value.Trim();
    }
}
