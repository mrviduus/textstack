using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Toc;
using TextStack.Extraction.Utilities;
using VersOne.Epub;
using VersOne.Epub.Schema;

namespace TextStack.Extraction.Extractors;

public sealed class EpubTextExtractor : ITextExtractor
{
    public SourceFormat SupportedFormat => SourceFormat.Epub;

    public async Task<ExtractionResult> ExtractAsync(ExtractionRequest request, CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();

        EpubBook book;
        try
        {
            book = await EpubReader.ReadBookAsync(request.Content);
        }
        catch (Exception ex)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.ParseError,
                $"Failed to parse EPUB: {ex.Message}"));

            return new ExtractionResult(
                SourceFormat.Epub,
                new ExtractionMetadata(null, null, null, null),
                [],
                [],
                new ExtractionDiagnostics(TextSource.None, null, warnings));
        }

        var title = book.Title;
        var authors = book.AuthorList?.Count > 0 ? string.Join(", ", book.AuthorList) : null;
        var description = book.Description;

        // Build navigation title map from EPUB's NCX/NAV
        var navTitleMap = BuildNavigationTitleMap(book);

        var units = new List<ContentUnit>();
        var tocChapters = new List<(int ChapterNumber, string Html)>();
        var order = 0;

        foreach (var textContent in book.ReadingOrder)
        {
            if (ct.IsCancellationRequested)
                break;

            try
            {
                var html = textContent.Content;
                if (string.IsNullOrWhiteSpace(html))
                    continue;

                var (cleanHtml, plainText) = HtmlCleaner.CleanHtml(html);
                if (string.IsNullOrWhiteSpace(plainText))
                    continue;

                var chapterNumber = order + 1;
                var filePath = textContent.FilePath;

                // Try to get title from EPUB navigation first, then HTML, then fallback
                var chapterTitle = GetChapterTitle(filePath, navTitleMap, html, chapterNumber);
                var wordCount = HtmlCleaner.CountWords(plainText);

                // Inject anchor IDs into headings for ToC navigation
                cleanHtml = TocGenerator.InjectAnchorIds(cleanHtml, chapterNumber);
                tocChapters.Add((chapterNumber, cleanHtml));

                units.Add(new ContentUnit(
                    Type: ContentUnitType.Chapter,
                    Title: chapterTitle,
                    Html: cleanHtml,
                    PlainText: plainText,
                    OrderIndex: order++,
                    WordCount: wordCount
                ));
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.ChapterParseError,
                    $"Failed to parse chapter: {ex.Message}"));
            }
        }

        // Generate table of contents
        var toc = TocGenerator.GenerateToc(tocChapters);

        ct.ThrowIfCancellationRequested();

        // Extract all images
        var images = new List<ExtractedImage>();
        byte[]? coverImage = null;
        string? coverMimeType = null;

        try
        {
            var coverFilePath = book.Schema.Package.Manifest.Items
                .FirstOrDefault(i => i.Properties?.Contains(EpubManifestProperty.COVER_IMAGE) == true)?.Href;

            foreach (var imageFile in book.Content.Images.Local)
            {
                try
                {
                    var imageBytes = imageFile.Content;
                    if (imageBytes == null || imageBytes.Length == 0)
                        continue;

                    var mimeType = GetMimeType(imageFile.ContentType) ?? ImageUtils.DetectMimeType(imageBytes);
                    var originalPath = imageFile.FilePath;
                    var isCover = coverFilePath != null &&
                                  (originalPath.EndsWith(coverFilePath, StringComparison.OrdinalIgnoreCase) ||
                                   originalPath.Contains("cover", StringComparison.OrdinalIgnoreCase));

                    if (isCover && coverImage == null)
                    {
                        coverImage = imageBytes;
                        coverMimeType = mimeType;
                    }

                    images.Add(new ExtractedImage(
                        OriginalPath: originalPath,
                        Data: imageBytes,
                        MimeType: mimeType,
                        IsCover: isCover
                    ));
                }
                catch (Exception ex)
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.ChapterParseError,
                        $"Failed to extract image {imageFile.FilePath}: {ex.Message}"));
                }
            }

            // Fallback: try book.CoverImage if no cover found yet
            if (coverImage == null)
            {
                var cover = book.CoverImage;
                if (cover != null)
                {
                    coverImage = cover;
                    coverMimeType = ImageUtils.DetectMimeType(cover);
                }
            }
        }
        catch
        {
            // Image extraction is optional, don't fail
        }

        var metadata = new ExtractionMetadata(title, authors, null, description, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

        return new ExtractionResult(SourceFormat.Epub, metadata, units, images, diagnostics, toc);
    }

    private static string? GetMimeType(EpubContentType contentType)
    {
        return contentType switch
        {
            EpubContentType.IMAGE_GIF => "image/gif",
            EpubContentType.IMAGE_JPEG => "image/jpeg",
            EpubContentType.IMAGE_PNG => "image/png",
            EpubContentType.IMAGE_SVG => "image/svg+xml",
            EpubContentType.IMAGE_WEBP => "image/webp",
            _ => null
        };
    }

    /// <summary>
    /// Builds a map of file paths to chapter titles from the EPUB's NCX/NAV navigation.
    /// </summary>
    private static Dictionary<string, string> BuildNavigationTitleMap(EpubBook book)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var navigation = book.Navigation;
            if (navigation == null)
                return map;

            void ProcessNavItems(IEnumerable<EpubNavigationItem>? items)
            {
                if (items == null) return;

                foreach (var item in items)
                {
                    if (!string.IsNullOrWhiteSpace(item.Title) && item.Link?.ContentFilePath != null)
                    {
                        var path = item.Link.ContentFilePath;
                        // Store without fragment (anchor)
                        var pathWithoutFragment = path.Contains('#') ? path[..path.IndexOf('#')] : path;

                        if (!map.ContainsKey(pathWithoutFragment))
                        {
                            map[pathWithoutFragment] = item.Title.Trim();
                        }
                    }

                    // Process nested items
                    ProcessNavItems(item.NestedItems);
                }
            }

            ProcessNavItems(navigation);
        }
        catch
        {
            // Navigation extraction is optional
        }

        return map;
    }

    /// <summary>
    /// Gets chapter title with fallback chain: NCX/NAV -> HTML h1/h2 -> "Chapter N"
    /// </summary>
    private static string GetChapterTitle(string filePath, Dictionary<string, string> navTitleMap, string html, int chapterNumber)
    {
        // 1. Try navigation map first (most reliable source)
        if (navTitleMap.TryGetValue(filePath, out var navTitle) && !string.IsNullOrWhiteSpace(navTitle))
        {
            // Skip if title looks like a file name (contains underscore + numbers pattern)
            if (!LooksLikeFileName(navTitle))
                return navTitle;
        }

        // 2. Try extracting from HTML (h1, h2, title tag)
        var htmlTitle = HtmlCleaner.ExtractTitle(html);
        if (!string.IsNullOrWhiteSpace(htmlTitle) && !LooksLikeFileName(htmlTitle))
        {
            return htmlTitle;
        }

        // 3. Fallback to generic chapter number
        return $"Chapter {chapterNumber}";
    }

    /// <summary>
    /// Checks if a string looks like a file name rather than a proper title.
    /// </summary>
    private static bool LooksLikeFileName(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return true;

        // File names often have patterns like: code_1, chapter-01, SF20_Code-4
        var normalized = text.Trim();

        // Contains file-like patterns
        if (System.Text.RegularExpressions.Regex.IsMatch(normalized, @"^[A-Za-z0-9_-]+$") &&
            System.Text.RegularExpressions.Regex.IsMatch(normalized, @"[_-]\d+|^\d+[_-]"))
        {
            return true;
        }

        return false;
    }
}
