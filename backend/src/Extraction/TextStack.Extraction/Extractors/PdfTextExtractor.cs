using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors.Pdf;
using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.Toc;
using TextStack.Extraction.Utilities;
using UglyToad.PdfPig;

namespace TextStack.Extraction.Extractors;

public sealed class PdfTextExtractor : ITextExtractor
{
    private const int MaxPages = 2000;
    private const int SampleCount = 10;
    private const int MinInlineImageBytes = 2048;

    public SourceFormat SupportedFormat => SourceFormat.Pdf;

    public Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();

        PdfDocument document;
        try
        {
            document = PdfDocument.Open(request.Content);
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"Failed to parse PDF: {ex.Message}"));

            return Task.FromResult(new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(null, null, null, null),
                [],
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings)));
        }

        try
        {
            return Task.FromResult(ExtractFromDocument(document, warnings, ct));
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"PDF extraction failed: {ex.Message}"));

            return Task.FromResult(new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(null, null, null, null),
                [],
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings)));
        }
        finally
        {
            document.Dispose();
        }
    }

    private static ExtractionResult ExtractFromDocument(
        PdfDocument document, List<ExtractionWarning> warnings, CancellationToken ct)
    {
        var pageCount = document.NumberOfPages;
        if (pageCount == 0)
        {
            warnings.Add(new ExtractionWarning(ExtractionWarningCode.EmptyContent, "PDF has no pages"));
            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(null, null, null, null),
                [], [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        if (pageCount > MaxPages)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.PartialExtraction,
                $"PDF has {pageCount} pages, limiting to {MaxPages}"));
            pageCount = MaxPages;
        }

        // Extract metadata
        var info = document.Information;
        var title = NullIfEmpty(info.Title);
        var authors = NullIfEmpty(info.Author);
        var description = NullIfEmpty(info.Subject);

        // Extract cover from page 1 early (before word check so image-only PDFs still get a cover)
        byte[]? coverImage = null;
        string? coverMimeType = null;
        try
        {
            var firstPage = document.GetPage(1);
            var (p1Images, _) = ExtractPageImages(firstPage, 1, warnings);
            var coverImg = p1Images.MaxBy(img => img.Data.Length);
            if (coverImg != null)
            {
                coverImage = coverImg.Data;
                coverMimeType = coverImg.MimeType;
            }
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to extract cover from page 1: {ex.Message}"));
        }

        // Quick text-layer check: sample pages spread across the document
        var totalWords = 0;
        var step = Math.Max(1, pageCount / SampleCount);
        for (var i = 1; i <= pageCount; i += step)
        {
            try { totalWords += document.GetPage(i).GetWords().Count(); }
            catch { /* sampling — safe to skip unreadable pages */ }
        }

        if (totalWords == 0)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "PDF has no extractable text (image-only)"));

            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType),
                [], [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Detect chapters
        var chapters = PdfChapterDetector.DetectChapters(document);

        // Extract content per chapter
        var units = new List<ContentUnit>();
        var tocChapters = new List<(int ChapterNumber, string Html)>();
        var allImages = new List<ExtractedImage>();

        for (var chapterIdx = 0; chapterIdx < chapters.Count; chapterIdx++)
        {
            if (ct.IsCancellationRequested)
                break;

            var chapter = chapters[chapterIdx];
            var chapterNumber = chapterIdx + 1;

            try
            {
                // Extract pages for this chapter
                var pageElements = new List<(int PageNumber, List<PdfTextElement> Elements)>();
                for (var p = chapter.StartPage; p <= Math.Min(chapter.EndPage, pageCount); p++)
                {
                    try
                    {
                        var page = document.GetPage(p);
                        var textElements = PdfPageTextExtractor.ExtractPage(page);

                        // Extract images and create inline elements
                        var (pageImages, inlinePositions) = ExtractPageImages(page, p, warnings);
                        allImages.AddRange(pageImages);

                        var imageElements = inlinePositions
                            .Select(pi => new PdfTextElement(
                                TextElementType.Image, pi.Path, false, false, pi.YPosition))
                            .ToList();

                        // Merge text + images, sort by Y descending (top of page first)
                        var merged = textElements.Concat(imageElements)
                            .OrderByDescending(e => e.YPosition)
                            .ToList();

                        if (merged.Count > 0)
                            pageElements.Add((p, merged));
                    }
                    catch (Exception ex)
                    {
                        warnings.Add(new ExtractionWarning(
                            ExtractionWarningCode.PageParseError,
                            $"Failed to extract page {p}: {ex.Message}"));
                    }
                }

                if (pageElements.Count == 0)
                    continue;

                // Convert to HTML
                var (html, plainText) = PdfToHtmlConverter.ConvertPages(pageElements);
                if (string.IsNullOrWhiteSpace(plainText))
                    continue;

                // Skip piracy watermarks
                try
                {
                    if (PiracyWatermarkProcessor.IsPiracyWatermark(html))
                    {
                        warnings.Add(new ExtractionWarning(
                            ExtractionWarningCode.ContentFiltered,
                            "Skipped piracy watermark chapter"));
                        continue;
                    }
                }
                catch { /* piracy detection is optional, same as EPUB */ }

                // Inject anchor IDs
                html = TocGenerator.InjectAnchorIds(html, chapterNumber);
                tocChapters.Add((chapterNumber, html));

                var wordCount = HtmlCleaner.CountWords(plainText);
                var chapterTitle = chapter.Title ?? $"Section {chapterNumber}";

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Chapter,
                    Title: chapterTitle,
                    Html: html,
                    PlainText: plainText,
                    OrderIndex: chapterIdx,
                    WordCount: wordCount));
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.ChapterParseError,
                    $"Failed to process chapter {chapterNumber}: {ex.Message}"));
            }
        }

        // No extractable text — likely image-only PDF
        if (units.Count == 0)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                "PDF produced no content units, may be image-only"));

            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType),
                [], allImages,
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Generate TOC
        var toc = TocGenerator.GenerateToc(tocChapters);

        // Override cover with largest page-1 image from chapter extraction (may be better quality)
        try
        {
            var coverImg = allImages
                .Where(img => img.OriginalPath.StartsWith("page-1-"))
                .MaxBy(img => img.Data.Length);
            if (coverImg != null)
            {
                coverImage = coverImg.Data;
                coverMimeType = coverImg.MimeType;
                var idx = allImages.IndexOf(coverImg);
                allImages[idx] = coverImg with { IsCover = true };
            }
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to select cover image: {ex.Message}"));
        }

        var metadata = new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

        return new ExtractionResult(SourceFormat.Pdf, metadata, units, allImages, diagnostics, toc);
    }

    /// <summary>
    /// Extracts images from a PDF page.
    /// Returns (all extracted images, inline positions for images above size threshold).
    /// </summary>
    private static (List<ExtractedImage> Images, List<(string Path, double YPosition)> InlinePositions)
        ExtractPageImages(UglyToad.PdfPig.Content.Page page, int pageNumber, List<ExtractionWarning> warnings)
    {
        var extractedImages = new List<ExtractedImage>();
        var inlinePositions = new List<(string Path, double YPosition)>();
        try
        {
            var pageImages = page.GetImages().ToList();
            for (var i = 0; i < pageImages.Count; i++)
            {
                try
                {
                    var img = pageImages[i];
                    var rawBytes = img.RawBytes.ToArray();

                    // Try raw bytes first — many PDF images are already JPEG/PNG
                    byte[] imageData;
                    string mimeType;

                    if (rawBytes.Length > 0 && IsRecognizedImage(rawBytes))
                    {
                        imageData = rawBytes;
                        mimeType = ImageUtils.DetectMimeType(rawBytes);
                    }
                    else if (img.TryGetPng(out var pngBytes) && pngBytes.Length > 0)
                    {
                        imageData = pngBytes;
                        mimeType = "image/png";
                    }
                    else
                    {
                        warnings.Add(new ExtractionWarning(
                            ExtractionWarningCode.CoverExtractionFailed,
                            $"Skipped unrecognized image on page {pageNumber} (raw={rawBytes.Length}b)"));
                        continue;
                    }

                    var path = $"page-{pageNumber}-img-{i}";
                    var yPosition = img.Bounds.Top;

                    extractedImages.Add(new ExtractedImage(
                        OriginalPath: path,
                        Data: imageData,
                        MimeType: mimeType,
                        IsCover: false));

                    if (imageData.Length >= MinInlineImageBytes)
                        inlinePositions.Add((path, yPosition));
                }
                catch (Exception ex)
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.CoverExtractionFailed,
                        $"Failed to extract image on page {pageNumber}: {ex.Message}"));
                }
            }
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"Failed to enumerate images on page {pageNumber}: {ex.Message}"));
        }
        return (extractedImages, inlinePositions);
    }

    private static bool IsRecognizedImage(byte[] data)
    {
        if (data.Length < 4) return false;

        // JPEG: FF D8 FF
        if (data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
            return true;

        // PNG: 89 50 4E 47
        if (data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47)
            return true;

        // GIF: 47 49 46 38
        if (data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x38)
            return true;

        // WebP: 52 49 46 46 ... 57 45 42 50
        if (data.Length >= 12 &&
            data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46 &&
            data[8] == 0x57 && data[9] == 0x45 && data[10] == 0x42 && data[11] == 0x50)
            return true;

        return false;
    }

    private static string? NullIfEmpty(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
