using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
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

        var units = new List<ContentUnit>();
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

                var chapterTitle = HtmlCleaner.ExtractTitle(html) ?? $"Chapter {order + 1}";
                var wordCount = HtmlCleaner.CountWords(plainText);

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

        return new ExtractionResult(SourceFormat.Epub, metadata, units, images, diagnostics);
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
}
