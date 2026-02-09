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
    private const int MinWordThreshold = 100;

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

        // Check text layer: count total words
        var totalWords = 0;
        for (var i = 1; i <= Math.Min(pageCount, 10); i++)
        {
            try
            {
                var page = document.GetPage(i);
                totalWords += page.GetWords().Count();
            }
            catch { }
        }

        if (totalWords < MinWordThreshold)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.NoTextLayer,
                $"PDF has very few words ({totalWords}), may be image-only"));

            return new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(title, authors, null, description),
                [], [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Detect chapters
        var chapters = PdfChapterDetector.DetectChapters(document);

        // Extract content per chapter
        var units = new List<ContentUnit>();
        var tocChapters = new List<(int ChapterNumber, string Html)>();
        var images = new List<ExtractedImage>();

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
                        var pageImages = ExtractPageImages(page, p, images, warnings);
                        var imageElements = pageImages
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
                catch { }

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

        // Generate TOC
        var toc = TocGenerator.GenerateToc(tocChapters);

        // Extract cover (largest image on page 1)
        byte[]? coverImage = null;
        string? coverMimeType = null;
        try
        {
            var coverImg = images
                .Where(img => img.OriginalPath.StartsWith("page-1-"))
                .MaxBy(img => img.Data.Length);
            if (coverImg != null)
            {
                coverImage = coverImg.Data;
                coverMimeType = coverImg.MimeType;
                // Mark it as cover
                var idx = images.IndexOf(coverImg);
                images[idx] = coverImg with { IsCover = true };
            }
        }
        catch { }

        var metadata = new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

        return new ExtractionResult(SourceFormat.Pdf, metadata, units, images, diagnostics, toc);
    }

    private static List<(string Path, double YPosition)> ExtractPageImages(
        UglyToad.PdfPig.Content.Page page, int pageNumber,
        List<ExtractedImage> images, List<ExtractionWarning> warnings)
    {
        var result = new List<(string Path, double YPosition)>();
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

                    images.Add(new ExtractedImage(
                        OriginalPath: path,
                        Data: imageData,
                        MimeType: mimeType,
                        IsCover: false));

                    // Only inline images > 2KB (skip tiny decorative elements)
                    if (imageData.Length >= 2048)
                        result.Add((path, yPosition));
                }
                catch (Exception ex)
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.CoverExtractionFailed,
                        $"Failed to extract image on page {pageNumber}: {ex.Message}"));
                }
            }
        }
        catch { }
        return result;
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

        return false;
    }

    private static string? NullIfEmpty(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
