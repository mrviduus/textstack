using HtmlAgilityPack;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.TextProcessing.Processors;
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
            // Single choke point for admin and user ingestion: refuse oversized archives before parsing.
            if (EpubArchiveGuard.Check(request.Content) is { } limitError)
                throw new InvalidDataException(limitError);
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

        var title = BookTitleCleaner.Clean(book.Title);
        var authors = book.AuthorList?.Count > 0 ? string.Join(", ", book.AuthorList) : null;
        var description = book.Description;
        var language = ExtractLanguage(book);

        // Build navigation title map from EPUB's NCX/NAV
        var navTitleMap = BuildNavigationTitleMap(book);

        var units = new List<ContentUnit>();
        var tocChapters = new List<(int ChapterNumber, string Html)>();
        var order = 0;
        ContentUnit? previousUnit = null;
        int previousUnitIndex = -1;

        // Single-file EPUB: try splitting by headings before standard processing
        if (book.ReadingOrder.Count == 1)
        {
            var singleHtml = book.ReadingOrder[0].Content;
            if (!string.IsNullOrWhiteSpace(singleHtml))
            {
                var sections = SplitSingleFileByHeadings(singleHtml);
                if (sections.Count > 1)
                {
                    foreach (var (sectionTitle, sectionHtml) in sections)
                    {
                        if (ct.IsCancellationRequested) break;

                        var (cleanHtml, plainText) = HtmlCleaner.Clean(sectionHtml);
                        if (string.IsNullOrWhiteSpace(plainText)) continue;

                        var wordCount = HtmlCleaner.CountWords(plainText);
                        var chapterNumber = order + 1;

                        cleanHtml = TocGenerator.InjectAnchorIds(cleanHtml, chapterNumber);
                        tocChapters.Add((chapterNumber, cleanHtml));

                        var newUnit = new ContentUnit(
                            Type: ContentUnitType.Chapter,
                            Title: sectionTitle,
                            Html: cleanHtml,
                            PlainText: plainText,
                            OrderIndex: order++,
                            WordCount: wordCount
                        );

                        units.Add(newUnit);
                    }

                    // Skip the standard loop — we already processed the single file
                    goto AfterReadingOrderLoop;
                }
            }
        }

        // Files that exist to BE navigation, not to be read. Publishers routinely
        // put the EPUB 3 nav document in the spine, so it arrived as chapter one:
        // DetectFrontMatterType titled it "Contents", and the reader opened a
        // user's book on a list of default-blue underlined links over the serif
        // page. The app builds its own table of contents from TocGenerator, so
        // this document has no reader left.
        //
        // Matched by file path from the EPUB schema, not by looking for the words
        // "table of contents" in the text — a real chapter is allowed to mention
        // them, and DetectFrontMatterType's fuzzy match is why the nav document
        // looked like legitimate front matter in the first place.
        var navigationPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var navDocPath = book.Schema.Epub3NavDocument?.FilePath;
        if (!string.IsNullOrWhiteSpace(navDocPath))
            navigationPaths.Add(navDocPath);
        var ncxPath = book.Schema.Epub2Ncx?.FilePath;
        if (!string.IsNullOrWhiteSpace(ncxPath))
            navigationPaths.Add(ncxPath);

        foreach (var textContent in book.ReadingOrder)
        {
            if (ct.IsCancellationRequested)
                break;

            try
            {
                if (!string.IsNullOrEmpty(textContent.FilePath) && navigationPaths.Contains(textContent.FilePath))
                {
                    warnings.Add(new ExtractionWarning(
                        ExtractionWarningCode.ContentFiltered,
                        "Skipped the navigation document listed in the spine"));
                    continue;
                }

                var html = textContent.Content;
                if (string.IsNullOrWhiteSpace(html))
                    continue;

                var (cleanHtml, plainText) = HtmlCleaner.Clean(html);
                if (string.IsNullOrWhiteSpace(plainText))
                    continue;

                // Skip piracy watermark chapters
                try
                {
                    if (PiracyWatermarkProcessor.IsPiracyWatermark(cleanHtml))
                    {
                        warnings.Add(new ExtractionWarning(
                            ExtractionWarningCode.ContentFiltered,
                            "Skipped piracy watermark chapter"));
                        continue;
                    }
                }
                catch
                {
                    // Ignore piracy detection errors, continue processing
                }

                var filePath = textContent.FilePath;
                var wordCount = HtmlCleaner.CountWords(plainText);

                // Check if this is a continuation (no proper title)
                var isProperChapter = HasProperTitle(filePath, navTitleMap, html);

                if (!isProperChapter && previousUnit != null)
                {
                    // Merge with previous chapter
                    var mergedHtml = previousUnit.Html + cleanHtml;
                    var mergedPlainText = previousUnit.PlainText + " " + plainText;
                    var mergedWordCount = previousUnit.WordCount + wordCount;

                    var updatedUnit = previousUnit with
                    {
                        Html = mergedHtml,
                        PlainText = mergedPlainText,
                        WordCount = mergedWordCount
                    };

                    units[previousUnitIndex] = updatedUnit;
                    tocChapters[previousUnitIndex] = (previousUnit.OrderIndex + 1, mergedHtml);
                    previousUnit = updatedUnit;
                    continue;
                }

                // Heading-stub recombination: the previous unit is a bare
                // chapter-number file (e.g. "<h1>10</h1>" → a 1-word chapter)
                // and THIS file is its body, split into a separate spine file.
                // Merge the body into the stub, keeping the stub's nav-derived
                // title — otherwise the book shows a 1-word "10" chapter followed
                // by a mis-titled body (Charisma Myth ch.10-13 in production).
                if (previousUnit != null && IsHeadingNumberStub(previousUnit))
                {
                    var mergedHtml = previousUnit.Html + cleanHtml;
                    var mergedPlainText = previousUnit.PlainText + " " + plainText;
                    var mergedWordCount = previousUnit.WordCount + wordCount;

                    var updatedUnit = previousUnit with
                    {
                        Html = mergedHtml,
                        PlainText = mergedPlainText,
                        WordCount = mergedWordCount
                    };

                    units[previousUnitIndex] = updatedUnit;
                    tocChapters[previousUnitIndex] = (previousUnit.OrderIndex + 1, mergedHtml);
                    previousUnit = updatedUnit;
                    continue;
                }

                // Regular chapter - create new unit
                var chapterNumber = order + 1;
                var chapterTitle = GetChapterTitle(filePath, navTitleMap, html, chapterNumber);

                // Inject anchor IDs into headings for ToC navigation
                cleanHtml = TocGenerator.InjectAnchorIds(cleanHtml, chapterNumber);
                tocChapters.Add((chapterNumber, cleanHtml));

                var newUnit = new ContentUnit(
                    Type: ContentUnitType.Chapter,
                    Title: chapterTitle,
                    Html: cleanHtml,
                    PlainText: plainText,
                    OrderIndex: order++,
                    WordCount: wordCount
                );

                units.Add(newUnit);
                previousUnit = newUnit;
                previousUnitIndex = units.Count - 1;
            }
            catch (Exception ex)
            {
                warnings.Add(new ExtractionWarning(
                    ExtractionWarningCode.ChapterParseError,
                    $"Failed to parse chapter: {ex.Message}"));
            }
        }

    AfterReadingOrderLoop:

        // Generate table of contents
        var toc = TocGenerator.GenerateToc(tocChapters);

        ct.ThrowIfCancellationRequested();

        // Extract all images
        var images = new List<ExtractedImage>();
        byte[]? coverImage = null;
        string? coverMimeType = null;

        try
        {
            // EPUB 3: properties="cover-image"
            var coverFilePath = book.Schema.Package.Manifest.Items
                .FirstOrDefault(i => i.Properties?.Contains(EpubManifestProperty.COVER_IMAGE) == true)?.Href;

            // EPUB 2 fallback: <meta name="cover" content="item-id"/>
            if (coverFilePath == null)
            {
                var coverMetaId = book.Schema.Package.Metadata.MetaItems
                    .FirstOrDefault(m => string.Equals(m.Name, "cover", StringComparison.OrdinalIgnoreCase))?.Content;
                if (coverMetaId != null)
                {
                    coverFilePath = book.Schema.Package.Manifest.Items
                        .FirstOrDefault(i => string.Equals(i.Id, coverMetaId, StringComparison.OrdinalIgnoreCase))?.Href;
                }
            }

            foreach (var imageFile in book.Content.Images.Local)
            {
                try
                {
                    var imageBytes = imageFile.Content;
                    if (imageBytes == null || imageBytes.Length == 0)
                        continue;

                    var mimeType = GetMimeType(imageFile.ContentType) ?? ImageUtils.DetectMimeType(imageBytes);
                    var originalPath = imageFile.FilePath;
                    var isCover = coverFilePath != null
                        ? (originalPath.EndsWith(coverFilePath, StringComparison.OrdinalIgnoreCase) ||
                           originalPath.Contains("cover", StringComparison.OrdinalIgnoreCase))
                        : Path.GetFileNameWithoutExtension(originalPath)
                              .Contains("cover", StringComparison.OrdinalIgnoreCase);

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

        var metadata = new ExtractionMetadata(title, authors, language, description, coverImage, coverMimeType);
        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);

        return new ExtractionResult(SourceFormat.Epub, metadata, units, images, diagnostics, toc);
    }

    /// <summary>
    /// Extracts the primary language from EPUB metadata (&lt;dc:language&gt;).
    /// Normalizes BCP47 tags like "en-US" to ISO 639-1 "en". Returns null if absent/invalid.
    /// </summary>
    private static string? ExtractLanguage(EpubBook book)
    {
        try
        {
            var languages = book.Schema?.Package?.Metadata?.Languages;
            if (languages == null || languages.Count == 0)
                return null;

            var raw = languages[0]?.Language?.Trim();
            if (string.IsNullOrEmpty(raw))
                return null;

            // "en-US" / "en_US" → "en"; already-2-letter stays as-is
            var sep = raw.IndexOfAny(['-', '_']);
            var code = sep > 0 ? raw[..sep] : raw;
            return code.Length is >= 2 and <= 3 ? code.ToLowerInvariant() : null;
        }
        catch
        {
            return null;
        }
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
    /// Gets chapter title with fallback chain: NCX/NAV -> HTML h1/h2 -> detect front matter -> "Section N"
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

        // 2. Try extracting from a VISIBLE heading (h1/h2/h3) — never the
        // <head><title>, which is the book title on every page in many EPUBs
        // and would mislabel every untitled spine file with the book name.
        var htmlTitle = HtmlCleaner.ExtractHeadingTitle(html);
        if (!string.IsNullOrWhiteSpace(htmlTitle) && !LooksLikeFileName(htmlTitle))
        {
            return htmlTitle;
        }

        // 3. Try to detect front matter type from content
        var frontMatterType = DetectFrontMatterType(html);
        if (frontMatterType != null)
            return frontMatterType;

        // 4. Fallback to "Section N" (avoids conflict with actual "Chapter N" titles)
        return $"Section {chapterNumber}";
    }

    /// <summary>
    /// Detects common front/back matter types from HTML content.
    /// Only applies to short sections to avoid false positives in chapter content.
    /// </summary>
    private static string? DetectFrontMatterType(string? html)
    {
        // Only detect front matter for short sections (< 3000 chars)
        // Longer sections are actual chapter content that may mention these words
        if (string.IsNullOrEmpty(html) || html.Length > 3000)
            return null;

        var lowerHtml = html.ToLowerInvariant();

        // Check for common front/back matter patterns (only in short sections)
        if (lowerHtml.Contains("copyright") || lowerHtml.Contains("©") || lowerHtml.Contains("all rights reserved"))
            return "Copyright";

        if (lowerHtml.Contains("table of contents"))
            return "Contents";

        // These need to be at the start or be the main content, not just mentioned
        if (html.Length < 1500)
        {
            if (lowerHtml.Contains("acknowledgment") || lowerHtml.Contains("acknowledgement"))
                return "Acknowledgments";

            if (lowerHtml.Contains("about the author"))
                return "About the Author";

            if (lowerHtml.Contains("afterword"))
                return "Afterword";

            if (lowerHtml.Contains("appendix"))
                return "Appendix";
        }

        return null;
    }

    /// <summary>
    /// Checks if a chapter has a proper title (not a continuation).
    /// </summary>
    private static bool HasProperTitle(string filePath, Dictionary<string, string> navTitleMap, string html)
    {
        // Has title in navigation?
        if (navTitleMap.TryGetValue(filePath, out var navTitle) &&
            !string.IsNullOrWhiteSpace(navTitle) &&
            !LooksLikeFileName(navTitle))
            return true;

        // Has a visible heading in HTML? (NOT <head><title> — see GetChapterTitle.)
        var htmlTitle = HtmlCleaner.ExtractHeadingTitle(html);
        if (!string.IsNullOrWhiteSpace(htmlTitle) && !LooksLikeFileName(htmlTitle))
            return true;

        // Has front matter type?
        if (DetectFrontMatterType(html) != null)
            return true;

        return false;
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

    /// <summary>
    /// Splits a single-file EPUB by h2/h3 headings that act as chapter boundaries.
    /// Returns empty list if fewer than 2 sections found (no split needed).
    /// </summary>
    private static List<(string Title, string Html)> SplitSingleFileByHeadings(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var body = doc.DocumentNode.SelectSingleNode("//body") ?? doc.DocumentNode;

        // Find all h2 and h3 that are direct children of body (chapter headings)
        // Skip the very first heading if it's the book title (h1)
        var headings = body.SelectNodes(".//h2 | .//h3");
        if (headings == null || headings.Count < 2)
            return [];

        // Filter to only headings that look like chapter/part markers
        var chapterHeadings = new List<HtmlNode>();
        var skipPatterns = new[]
        {
            "novel by", "books by", "the end", "copyright", "published by",
            "printed in", "all rights reserved", "table of contents",
            "about the author", "acknowledgment", "acknowledgement",
        };
        foreach (var h in headings)
        {
            var text = HtmlEntity.DeEntitize(h.InnerText).Trim();
            if (text.Length > 100) continue;
            if (string.IsNullOrWhiteSpace(text)) continue;
            var lower = text.ToLowerInvariant();
            if (skipPatterns.Any(p => lower.Contains(p))) continue;
            chapterHeadings.Add(h);
        }

        // Skip headings before the first h2 that looks like a part/chapter marker
        // (filter out title page headings like author names)
        var firstPartIndex = chapterHeadings.FindIndex(h =>
        {
            var text = HtmlEntity.DeEntitize(h.InnerText).Trim();
            return IsChapterOrPartHeading(text);
        });
        if (firstPartIndex > 0)
            chapterHeadings = chapterHeadings.Skip(firstPartIndex).ToList();

        if (chapterHeadings.Count < 2)
            return [];

        var sections = new List<(string Title, string Html)>();
        string? currentPartName = null;

        for (int i = 0; i < chapterHeadings.Count; i++)
        {
            var heading = chapterHeadings[i];
            var title = HtmlEntity.DeEntitize(heading.InnerText).Trim();
            var isPartHeading = heading.Name == "h2";

            // Track part name for prefixing chapter titles
            if (isPartHeading)
                currentPartName = title;

            // Collect all nodes between this heading and the next (or end)
            var sectionNodes = new List<HtmlNode>();

            // Include the <hr> before the heading if present
            var prevSibling = heading.PreviousSibling;
            while (prevSibling != null && (prevSibling.NodeType == HtmlNodeType.Text && string.IsNullOrWhiteSpace(prevSibling.InnerText)))
                prevSibling = prevSibling.PreviousSibling;

            // Add the heading itself
            sectionNodes.Add(heading);

            // Collect siblings until next chapter heading
            var nextHeading = i + 1 < chapterHeadings.Count ? chapterHeadings[i + 1] : null;
            var node = heading.NextSibling;
            while (node != null)
            {
                if (node == nextHeading) break;
                // Also check if next heading is preceded by an <hr>
                if (nextHeading != null && node.NextSibling == nextHeading && node.Name == "hr") break;
                // Check if this node contains the next heading (for nested structures)
                if (nextHeading != null && node.Descendants().Any(d => d == nextHeading)) break;
                sectionNodes.Add(node);
                node = node.NextSibling;
            }

            // Build section HTML
            var sectionHtml = string.Join("", sectionNodes.Select(n => n.OuterHtml));
            if (string.IsNullOrWhiteSpace(HtmlCleaner.Clean(sectionHtml).PlainText))
                continue;

            // Build display title
            string displayTitle;
            if (isPartHeading)
            {
                displayTitle = $"Part {title}";
            }
            else if (currentPartName != null)
            {
                displayTitle = $"Part {currentPartName}, Chapter {title}";
            }
            else
            {
                displayTitle = $"Chapter {title}";
            }

            sections.Add((displayTitle, sectionHtml));
        }

        return sections.Count >= 2 ? sections : [];
    }

    // A bare chapter number like "10" — matched against a unit's collapsed plain
    // text to detect heading-only spine files. Runtime Regex (not [GeneratedRegex])
    // per the ARM64 SIGILL caveat in RULES.md.
    private static readonly System.Text.RegularExpressions.Regex NumberStubRegex = new(@"^\d{1,3}$");

    /// <summary>
    /// True when a unit is just a chapter-number heading (e.g. a "&lt;h1&gt;10&lt;/h1&gt;"
    /// spine file): a handful of words whose text is only digits. Such files are
    /// the heading half of a chapter split across two spine files.
    /// </summary>
    private static bool IsHeadingNumberStub(ContentUnit unit)
    {
        if (unit.WordCount > 3) return false;
        var text = unit.PlainText?.Trim();
        if (string.IsNullOrEmpty(text)) return false;
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim();
        return NumberStubRegex.IsMatch(text);
    }

    private static readonly System.Text.RegularExpressions.Regex ChapterPartRegex = new(
        @"^(chapter|part|book|section|глава|часть|частина|розділ|prologue|epilogue|appendix|introduction|preface|foreword)\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private static readonly string[] RomanNumerals =
        ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
         "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];

    private static readonly string[] NumberWords =
        ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
         "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN",
         "EIGHTEEN", "NINETEEN", "TWENTY"];

    /// <summary>
    /// Checks if a heading text looks like a chapter/part marker (Roman numeral, number word, or keyword).
    /// </summary>
    private static bool IsChapterOrPartHeading(string text)
    {
        if (ChapterPartRegex.IsMatch(text)) return true;
        var upper = text.Trim().ToUpperInvariant();
        if (RomanNumerals.Contains(upper)) return true;
        if (NumberWords.Contains(upper)) return true;
        if (int.TryParse(text.Trim(), out _)) return true;
        return false;
    }
}
