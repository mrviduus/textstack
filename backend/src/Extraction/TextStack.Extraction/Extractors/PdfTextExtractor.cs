using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors.Pdf;
using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.Toc;
using TextStack.Extraction.Utilities;
using PDFtoImage;
using SkiaSharp;
using UglyToad.PdfPig;

namespace TextStack.Extraction.Extractors;

public sealed class PdfTextExtractor : ITextExtractor
{
    private const int MaxPages = 2000;
    private const int SampleCount = 10;
    private const int MinInlineImageBytes = 2048;

    public SourceFormat SupportedFormat => SourceFormat.Pdf;

    /// <summary>
    /// The document's page count from its page tree alone — no text, no rendering. Null when the
    /// stream is not a readable PDF. Used to backfill <c>UserBook.PageCount</c> without re-ingestion.
    /// </summary>
    public static int? CountPages(Stream content)
    {
        try
        {
            using var document = PdfDocument.Open(content);
            return document.NumberOfPages;
        }
        catch (Exception)
        {
            return null;
        }
    }

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
            // Read stream to byte[] for both PdfPig (already open) and PDFtoImage fallback
            byte[] pdfBytes;
            if (request.Content is MemoryStream ms)
            {
                pdfBytes = ms.ToArray();
            }
            else
            {
                using var copy = new MemoryStream();
                request.Content.Position = 0;
                request.Content.CopyTo(copy);
                pdfBytes = copy.ToArray();
            }
            return Task.FromResult(ExtractFromDocument(
                document, pdfBytes, request.Options.ExtractInlineImages, warnings, ct));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"PDF extraction failed: {ex.Message}"));

            // The document opened, so the Original layout can still page it.
            return Task.FromResult(new ExtractionResult(
                SourceFormat.Pdf,
                new ExtractionMetadata(null, null, null, null, PageCount: document.NumberOfPages),
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
        PdfDocument document, byte[] pdfBytes, bool extractInlineImages,
        List<ExtractionWarning> warnings, CancellationToken ct)
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

        // The real total, before the MaxPages clamp below — this is what the reader sees.
        var totalPages = pageCount;
        if (pageCount > MaxPages)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.PartialExtraction,
                $"PDF has {pageCount} pages, limiting to {MaxPages}"));
            pageCount = MaxPages;
        }

        // Extract metadata
        var info = document.Information;
        var title = BookTitleCleaner.Clean(NullIfEmpty(info.Title));
        var authors = NullIfEmpty(info.Author);
        var description = NullIfEmpty(info.Subject);

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
                new ExtractionMetadata(title, authors, null, description, PageCount: totalPages),
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
            // Throw, never break: a truncated result would be saved as the whole book.
            ct.ThrowIfCancellationRequested();

            var chapter = chapters[chapterIdx];
            var chapterNumber = chapterIdx + 1;
            // TOC almost always sits in the front half of the book; Index /
            // Glossary in the back. The guard prevents an Italian/Spanish
            // "Indice/Índice" — same word means "Index" at the back and
            // "TOC" at the front — from being mis-dropped when it's the Index.
            var isFrontHalf = chapterIdx * 2 < chapters.Count;

            // Drop TOC chapters at extraction time. PDF TOCs come out as one
            // dense run of leader-dotted entries and we already build the
            // reader-side TOC from the chapter list itself. Two guards:
            //   • single-chapter book (don't disappear the only content);
            //   • chapter is in the front half (see ambiguous-word note above).
            if (chapters.Count > 1 && isFrontHalf && FrontMatterFilter.IsTableOfContents(chapter.Title))
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.ContentFiltered,
                    $"Skipped Table of Contents chapter: {chapter.Title}"));
                continue;
            }

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

                        // Inline-image extraction is gated (ADR-012 S5a). User PDFs
                        // render pixel-perfect via PDF.js and RAG re-renders pages via
                        // vision, so extracted chapter <img> are dead weight there
                        // (flag off = text-only page). The admin-catalog reflow path
                        // sets the flag true to keep its inline figures. The cover is
                        // unaffected — always rendered below via RenderFirstPageAsCover.
                        List<PdfTextElement> merged;
                        if (extractInlineImages)
                        {
                            var (pageImages, inlinePositions) = ExtractPageImages(page, p, warnings);
                            allImages.AddRange(pageImages);

                            var imageElements = inlinePositions
                                .Select(pi => new PdfTextElement(
                                    TextElementType.Image, pi.Path, false, false, pi.YPosition))
                                .ToList();

                            // Merge text + images, sort by Y descending (top of page first)
                            merged = textElements.Concat(imageElements)
                                .OrderByDescending(e => e.YPosition)
                                .ToList();
                        }
                        else
                        {
                            merged = textElements;
                        }

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

                // Drop running headers/footers — short paragraphs that repeat
                // across ≥3 pages (e.g. "Chapter 1: Introduction…" or book title
                // running header). Done per-chapter so we don't accidentally drop
                // genuine cross-chapter repetition like author bylines.
                var filteredPageElements = FilterRunningHeaders(pageElements);

                // Content-level TOC drop happens BEFORE HTML conversion so:
                //  (a) we don't waste the HtmlCleaner pipeline on a chapter
                //      we're about to throw away, and
                //  (b) the detector works on raw paragraph texts — decoupled
                //      from PdfToHtmlConverter's markup choices. Three guards:
                //   • single-chapter book (don't disappear the only content);
                //   • chapter is in the back half (Index/Glossary live there
                //     and look exactly like TOC by content);
                //   • bookmark title matches a known back-matter section
                //     (Index, Glossary, Bibliography, …).
                if (chapters.Count > 1
                    && isFrontHalf
                    && !FrontMatterFilter.IsKnownBackMatter(chapter.Title))
                {
                    var paragraphTexts = filteredPageElements
                        .SelectMany(pe => pe.Elements)
                        .Where(e => e.Type == TextElementType.Paragraph)
                        .Select(e => e.Text);
                    if (FrontMatterFilter.LooksLikeTableOfContentsBody(paragraphTexts))
                    {
                        warnings.Add(new ExtractionWarning(
                            ExtractionWarningCode.ContentFiltered,
                            $"Skipped Table of Contents chapter (content-detected): {chapter.Title}"));
                        continue;
                    }
                }

                // Convert to HTML
                var (html, plainText) = PdfToHtmlConverter.ConvertPages(filteredPageElements);
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
                    WordCount: wordCount,
                    // Physical PDF page range for the "Original layout" reader jump.
                    SourceStartPage: chapter.StartPage,
                    SourceEndPage: Math.Min(chapter.EndPage, pageCount)));
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
                new ExtractionMetadata(title, authors, null, description, PageCount: totalPages),
                [], allImages,
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        // Generate TOC
        var toc = TocGenerator.GenerateToc(tocChapters);

        // Extract cover: try largest page-1 embedded image first, then render page 1
        byte[]? coverImage = null;
        string? coverMimeType = null;
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

        // Fallback: render page 1 as cover if no embedded image found
        if (coverImage == null)
        {
            try
            {
                coverImage = RenderFirstPageAsCover(pdfBytes, warnings);
                if (coverImage != null)
                    coverMimeType = "image/jpeg";
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.CoverExtractionFailed,
                    $"Failed to render page 1 as cover: {ex.Message}"));
            }
        }

        var metadata = new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType, totalPages);
        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

        return new ExtractionResult(SourceFormat.Pdf, metadata, units, allImages, diagnostics, toc);
    }

    private const int RunningHeaderMinPages = 3;
    private const int RunningHeaderMaxTextLength = 200;

    private static List<(int PageNumber, List<PdfTextElement> Elements)> FilterRunningHeaders(
        List<(int PageNumber, List<PdfTextElement> Elements)> pageElements)
    {
        if (pageElements.Count < RunningHeaderMinPages)
            return pageElements;

        var occurrences = new Dictionary<string, HashSet<int>>(StringComparer.Ordinal);
        foreach (var (pageNum, elements) in pageElements)
        {
            foreach (var e in elements)
            {
                if (e.Type != TextElementType.Paragraph) continue;
                var text = e.Text.Trim();
                if (text.Length == 0 || text.Length > RunningHeaderMaxTextLength) continue;
                if (!occurrences.TryGetValue(text, out var pages))
                {
                    pages = [];
                    occurrences[text] = pages;
                }
                pages.Add(pageNum);
            }
        }

        var headers = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (text, pages) in occurrences)
        {
            if (pages.Count >= RunningHeaderMinPages)
                headers.Add(text);
        }

        if (headers.Count == 0)
            return pageElements;

        return pageElements
            .Select(p => (p.PageNumber, p.Elements
                .Where(e => e.Type != TextElementType.Paragraph || !headers.Contains(e.Text.Trim()))
                .ToList()))
            .ToList();
    }

    /// <summary>
    /// Extracts images from a PDF page.
    /// Returns (all extracted images, inline positions for images above size threshold).
    /// </summary>
    // Word→Quartz stacks the same figure as several overlapping XObjects at the
    // same bounding box (base + soft-mask companions + duplicate layers). Two
    // bbox corners within this many points count as "the same box".
    private const double BoundingBoxTolerance = 2.0;
    // An image whose box covers at least this fraction of BOTH page dimensions is
    // a full-page background/scan, not an inline figure — keep it (cover
    // candidate) but never inline it into the reading flow.
    private const double FullPageCoverRatio = 0.9;
    // Minimum rendered size (PDF points, ~1/72") for an image to be inlined.
    // Word→Quartz scatters dozens of tiny transparent annotation labels
    // (numbers/arrows, ~15–30pt) over diagrams; inlining them as standalone
    // <img> is noise. Real figures are comfortably larger than this.
    private const double MinInlineBoundingBoxPoints = 48.0;

    private static (List<ExtractedImage> Images, List<(string Path, double YPosition)> InlinePositions)
        ExtractPageImages(UglyToad.PdfPig.Content.Page page, int pageNumber, List<ExtractionWarning> warnings)
    {
        var extractedImages = new List<ExtractedImage>();
        var inlinePositions = new List<(string Path, double YPosition)>();
        try
        {
            var pageImages = page.GetImages().ToList();
            // Collapse overlapping same-bbox stacks to a single representative so
            // we don't emit the black base + empty soft-mask companion as two
            // separate boxes. Keep the largest raw payload (the real base image).
            var representatives = SelectBoundingBoxRepresentatives(pageImages);

            foreach (var (i, img) in representatives)
            {
                try
                {
                    var rawBytes = img.RawBytes.ToArray();

                    // Try raw bytes first — many PDF images are already JPEG/PNG.
                    byte[] imageData;
                    string mimeType;

                    if (rawBytes.Length > 0 && IsRecognizedImage(rawBytes))
                    {
                        imageData = rawBytes;
                        mimeType = ImageUtils.DetectMimeType(rawBytes);
                    }
                    else if (img.TryGetPng(out var pngBytes) && pngBytes.Length > 0)
                    {
                        // TryGetPng composites the /SMask into the alpha channel
                        // (verified: transparent figures decode with real alpha),
                        // so figures render with transparency instead of a black
                        // box. Drop the ones that composite to nothing — the
                        // fully-transparent overlay boxes Quartz sprinkles around
                        // diagrams — so we don't emit invisible <img> placeholders.
                        if (IsDegeneratePng(pngBytes))
                            continue;

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
                    var yPosition = img.BoundingBox.Top;

                    extractedImages.Add(new ExtractedImage(
                        OriginalPath: path,
                        Data: imageData,
                        MimeType: mimeType,
                        IsCover: false));

                    // Inline only genuine figures: not a full-page background,
                    // physically large enough to be content (not a scattered
                    // annotation label), and above the byte-size floor.
                    var bbox = img.BoundingBox;
                    var isFullPage = IsFullPageImage(bbox, page.Width, page.Height);
                    var isLargeEnough = bbox.Width >= MinInlineBoundingBoxPoints
                                        && bbox.Height >= MinInlineBoundingBoxPoints;
                    if (!isFullPage && isLargeEnough && imageData.Length >= MinInlineImageBytes)
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

    /// <summary>
    /// Groups a page's images by bounding box (within tolerance) and returns one
    /// representative per group — the largest raw payload, which is the real base
    /// layer rather than its thin soft-mask companion. Preserves the original
    /// index so inline image paths stay stable/unique.
    /// </summary>
    private static List<(int Index, UglyToad.PdfPig.Content.IPdfImage Image)> SelectBoundingBoxRepresentatives(
        List<UglyToad.PdfPig.Content.IPdfImage> images)
    {
        var groups = new List<List<(int Index, UglyToad.PdfPig.Content.IPdfImage Image)>>();

        for (var i = 0; i < images.Count; i++)
        {
            var img = images[i];
            var placed = false;
            foreach (var group in groups)
            {
                if (SameBoundingBox(group[0].Image.BoundingBox, img.BoundingBox))
                {
                    group.Add((i, img));
                    placed = true;
                    break;
                }
            }
            if (!placed)
                groups.Add([(i, img)]);
        }

        return groups
            .Select(g => g
                .OrderByDescending(x => x.Image.RawBytes.Length)
                .First())
            .OrderBy(x => x.Index)
            .ToList();
    }

    private static bool SameBoundingBox(
        UglyToad.PdfPig.Core.PdfRectangle a, UglyToad.PdfPig.Core.PdfRectangle b)
        => Math.Abs(a.Left - b.Left) <= BoundingBoxTolerance
           && Math.Abs(a.Bottom - b.Bottom) <= BoundingBoxTolerance
           && Math.Abs(a.Right - b.Right) <= BoundingBoxTolerance
           && Math.Abs(a.Top - b.Top) <= BoundingBoxTolerance;

    private static bool IsFullPageImage(
        UglyToad.PdfPig.Core.PdfRectangle bbox, double pageWidth, double pageHeight)
    {
        if (pageWidth <= 0 || pageHeight <= 0)
            return false;
        return bbox.Width >= pageWidth * FullPageCoverRatio
               && bbox.Height >= pageHeight * FullPageCoverRatio;
    }

    // How many pixels to probe per axis when checking a decoded PNG for
    // degeneracy. Cheap constant-cost sample independent of image size.
    private const int DegenerateSampleStride = 16;

    /// <summary>
    /// True when a decoded PNG carries no visible content: a 1×1 placeholder, or
    /// every sampled pixel is fully transparent (the empty soft-mask overlay
    /// boxes). Sampled sparsely so cost is bounded regardless of dimensions.
    /// </summary>
    internal static bool IsDegeneratePng(byte[] pngBytes)
    {
        try
        {
            using var image = SKBitmap.Decode(pngBytes);
            if (image is null)
                return false;
            if (image.Width <= 1 && image.Height <= 1)
                return true;

            var stepX = Math.Max(1, image.Width / DegenerateSampleStride);
            var stepY = Math.Max(1, image.Height / DegenerateSampleStride);
            byte maxAlpha = 0;
            for (var y = 0; y < image.Height; y += stepY)
            {
                for (var x = 0; x < image.Width; x += stepX)
                {
                    var alpha = image.GetPixel(x, y).Alpha;
                    if (alpha > maxAlpha)
                        maxAlpha = alpha;
                    if (maxAlpha > 8)
                        return false; // has visible content — not degenerate
                }
            }
            return true; // all sampled pixels effectively transparent
        }
        catch
        {
            // If we can't decode it, don't treat it as degenerate — let the
            // normal path keep it (a genuine PNG the decoder choked on).
            return false;
        }
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

    private static byte[]? RenderFirstPageAsCover(byte[] pdfBytes, List<ExtractionWarning> warnings)
    {
        try
        {
            using var pdfStream = new MemoryStream(pdfBytes);
            using var imageStream = new MemoryStream();
#pragma warning disable CA1416 // Platform compatibility — worker runs on Linux
            Conversion.SaveJpeg(imageStream, pdfStream, Index.FromStart(0),
                options: new RenderOptions(Dpi: 150));
#pragma warning restore CA1416
            var result = imageStream.ToArray();
            return result.Length > 0 ? result : null;
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.CoverExtractionFailed,
                $"PDFtoImage render failed: {ex.Message}"));
            return null;
        }
    }

    private static string? NullIfEmpty(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
