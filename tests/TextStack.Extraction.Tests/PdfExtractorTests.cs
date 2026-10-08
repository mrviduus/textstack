using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Tests.Helpers;

namespace TextStack.Extraction.Tests;

public class PdfExtractorTests
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "sample_textlayer.pdf");

    [Fact]
    public async Task ExtractAsync_ValidPdf_ReturnsCorrectFormat()
    {
        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "sample.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
        // sample_textlayer.pdf may or may not have enough words for NativeText
        Assert.True(result.Diagnostics.TextSource == TextSource.NativeText ||
                    result.Diagnostics.TextSource == TextSource.None);
    }

    [Fact]
    public async Task ExtractAsync_InvalidStream_NeverThrows()
    {
        var extractor = new PdfTextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("not a valid pdf"));
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.pdf" };

        var exception = await Record.ExceptionAsync(() => extractor.ExtractAsync(request));

        Assert.Null(exception);
    }

    [Fact]
    public async Task ExtractAsync_EmptyPdf_ReturnsWarning()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateEmptyPdf();
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "empty.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Equal(TextSource.None, result.Diagnostics.TextSource);
        Assert.True(result.Diagnostics.Warnings.Count > 0);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ReturnsUnitsWithText()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotEmpty(result.Units);
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
        Assert.Equal(SourceFormat.Pdf, result.SourceFormat);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ExtractsText()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        var allText = string.Join(" ", result.Units.Select(u => u.PlainText));
        Assert.NotEmpty(allText.Trim());
        Assert.Contains("Lorem ipsum", allText);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_ChaptersHaveTitlesAndWordCount()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.All(result.Units, u =>
        {
            Assert.NotNull(u.Title);
            Assert.NotNull(u.Html);
            Assert.NotEmpty(u.PlainText);
            Assert.True(u.WordCount > 0);
        });
    }

    [Fact]
    public async Task ExtractAsync_PdfWithJpeg_DefaultOff_RendersCoverWithoutInlineImages()
    {
        // ADR-012 S5a: inline-image extraction is OFF by default, but the cover
        // must ALWAYS render (via RenderFirstPageAsCover), independent of the flag.
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GeneratePdfWithJpegImage(10);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "with-image.pdf" };

        var result = await extractor.ExtractAsync(request);

        // Cover populated from the rendered page-1, not the embedded image.
        Assert.NotNull(result.Metadata.CoverImage);
        Assert.NotEmpty(result.Metadata.CoverImage);
        Assert.Equal("image/jpeg", result.Metadata.CoverMimeType);
        // Flag off ⇒ no embedded inline images extracted at all.
        Assert.Empty(result.Images);
    }

    [Fact]
    public async Task ExtractAsync_PdfWithImages_DefaultOff_HasNoImgTagsInHtml()
    {
        // ADR-012 S5a: user-book default drops inline images — page = text only.
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GeneratePdfWithImagesOnMultiplePages(10);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "with-images.pdf" };

        var result = await extractor.ExtractAsync(request);

        var allHtml = string.Join(" ", result.Units.Select(u => u.Html));
        Assert.DoesNotContain("<img", allHtml);
        Assert.DoesNotContain("page-1-img-", allHtml);
        Assert.Empty(result.Images);
    }

    [Fact]
    public async Task ExtractAsync_PdfWithImages_FlagOn_HasImgTagsInHtml()
    {
        // ADR-012 S5a: admin-catalog reflow path opts in — inline figures preserved.
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GeneratePdfWithImagesOnMultiplePages(10);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest
        {
            Content = stream,
            FileName = "with-images.pdf",
            Options = new ExtractionOptions { ExtractInlineImages = true }
        };

        var result = await extractor.ExtractAsync(request);

        var allHtml = string.Join(" ", result.Units.Select(u => u.Html));
        Assert.Contains("<img", allHtml);
        Assert.Contains("page-1-img-0", allHtml);
        Assert.NotEmpty(result.Images);
    }

    [Fact]
    public async Task ExtractAsync_WordQuartzWorkbook_DefaultOff_ExtractsNoInlineImages()
    {
        // ADR-012 S5a repurpose of the #412 "no black/duplicate boxes" test:
        // under the default-off flag the user-book path extracts NO inline images,
        // so there can be no black/duplicate boxes to worry about. Assert the whole
        // page = text-only: empty Images and no page-*-img-* refs in any unit HTML.
        var fixturePath = Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "KMK Optometry OSCE E-Workbook.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "KMK OSCE workbook fixture not present");

        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(fixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "kmk.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Empty(result.Images);
        // No inline <img> emitted (the only source of page-*-img-* refs).
        Assert.All(result.Units, u =>
        {
            Assert.DoesNotContain("<img", u.Html, StringComparison.Ordinal);
            Assert.DoesNotContain("-img-", u.Html, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task ExtractAsync_WordQuartzWorkbook_FlagOn_NoBlackOrDuplicateBoxImages()
    {
        // Admin-catalog path (flag on) still guards against black/duplicate boxes.
        var fixturePath = Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "KMK Optometry OSCE E-Workbook.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "KMK OSCE workbook fixture not present");

        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(fixturePath);
        var request = new ExtractionRequest
        {
            Content = stream,
            FileName = "kmk.pdf",
            Options = new ExtractionOptions { ExtractInlineImages = true }
        };

        var result = await extractor.ExtractAsync(request);

        // Inlined images = those actually referenced in chapter HTML.
        var inlinedPaths = new HashSet<string>();
        foreach (var unit in result.Units)
        {
            var idx = 0;
            while ((idx = unit.Html.IndexOf("page-", idx, StringComparison.Ordinal)) >= 0)
            {
                var end = idx;
                while (end < unit.Html.Length &&
                       (char.IsLetterOrDigit(unit.Html[end]) || unit.Html[end] == '-'))
                    end++;
                inlinedPaths.Add(unit.Html[idx..end]);
                idx = end;
            }
        }

        // Soft-mask companion / stacked-duplicate suppression keeps the inline
        // count modest — nowhere near the 153 raw XObjects in the source.
        Assert.True(inlinedPaths.Count < 60,
            $"too many inline images ({inlinedPaths.Count}) — dedup/full-page suppression failed");

        // Every inlined image must decode and NOT be a solid black (or fully
        // transparent) box.
        var inlined = result.Images.Where(i => inlinedPaths.Contains(i.OriginalPath)).ToList();
        Assert.NotEmpty(inlined);
        foreach (var img in inlined)
        {
            using var image = SkiaSharp.SKBitmap.Decode(img.Data);
            Assert.NotNull(image);

            long visibleLuma = 0;
            var visiblePixels = 0;
            var totalPixels = 0;
            var stepX = Math.Max(1, image.Width / 16);
            var stepY = Math.Max(1, image.Height / 16);
            for (var y = 0; y < image.Height; y += stepY)
            {
                for (var x = 0; x < image.Width; x += stepX)
                {
                    totalPixels++;
                    var px = image.GetPixel(x, y);
                    if (px.Alpha <= 8) continue; // transparent — not "black"
                    visiblePixels++;
                    visibleLuma += (px.Red + px.Green + px.Blue) / 3;
                }
            }

            // A real figure has some visible content.
            Assert.True(visiblePixels > 0, $"{img.OriginalPath} is fully transparent");

            // Solid black box = mostly opaque AND uniformly black. Transparent
            // black text/label overlays (few opaque black glyph pixels over a
            // transparent field) are legitimate and excluded from this check.
            var opaqueFraction = (double)visiblePixels / totalPixels;
            if (opaqueFraction >= 0.5)
            {
                var avgLuma = visibleLuma / visiblePixels;
                Assert.True(avgLuma > 10,
                    $"{img.OriginalPath} looks like a solid black box (avgLuma={avgLuma})");
            }
        }
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_PopulatesSourcePageRange()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        // Every PDF unit must carry a 1-based physical page range for the
        // "Original layout" reader jump. 30 pages / 15-per-split = 2 chapters:
        // pages 1-15 and 16-30.
        Assert.All(result.Units, u =>
        {
            Assert.NotNull(u.SourceStartPage);
            Assert.NotNull(u.SourceEndPage);
            Assert.True(u.SourceStartPage >= 1);
            Assert.True(u.SourceEndPage >= u.SourceStartPage);
        });
        Assert.Equal(1, result.Units[0].SourceStartPage);
        Assert.Equal(15, result.Units[0].SourceEndPage);
        Assert.Equal(16, result.Units[1].SourceStartPage);
        Assert.Equal(30, result.Units[1].SourceEndPage);
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_SourceEndPageClampedToPageCount()
    {
        // The unit builder clamps each chapter's end via Math.Min(chapter.EndPage,
        // pageCount) so a detected range can never point past the last processed
        // page (which would break the reader's page jump). 30-page doc → the final
        // unit must end exactly at page 30, and NO unit may exceed it.
        const int pages = 30;
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(pages);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.All(result.Units, u => Assert.True(
            u.SourceEndPage <= pages,
            $"SourceEndPage {u.SourceEndPage} overflowed page count {pages}"));
        Assert.Equal(pages, result.Units.Max(u => u.SourceEndPage));
    }

    [Fact]
    public async Task ExtractAsync_WordQuartzWorkbook_SourceEndPageNeverExceedsDocumentPages()
    {
        var fixturePath = Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "KMK Optometry OSCE E-Workbook.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "KMK OSCE workbook fixture not present");

        int documentPages;
        using (var doc = UglyToad.PdfPig.PdfDocument.Open(fixturePath))
            documentPages = doc.NumberOfPages;

        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(fixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "kmk.pdf" };

        var result = await extractor.ExtractAsync(request);

        // Real bookmarked book: the clamp must hold against actual document pages.
        Assert.All(result.Units, u =>
        {
            Assert.NotNull(u.SourceEndPage);
            Assert.True(u.SourceEndPage <= documentPages,
                $"SourceEndPage {u.SourceEndPage} exceeded document pages {documentPages}");
            Assert.True(u.SourceStartPage <= u.SourceEndPage);
        });
    }

    [Fact]
    public async Task ExtractAsync_WordQuartzWorkbook_UnitsHaveSourceStartPage()
    {
        var fixturePath = Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "KMK Optometry OSCE E-Workbook.pdf");
        Assert.SkipWhen(!File.Exists(fixturePath), "KMK OSCE workbook fixture not present");

        var extractor = new PdfTextExtractor();
        await using var stream = File.OpenRead(fixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "kmk.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.NotEmpty(result.Units);
        // Real-world PDF: chapter→page map must be present & monotonically ordered.
        Assert.All(result.Units, u =>
        {
            Assert.NotNull(u.SourceStartPage);
            Assert.True(u.SourceStartPage >= 1);
        });
    }

    [Fact]
    public async Task ExtractAsync_GeneratedPdf_FallsBackToPageSplitting()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(30);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        // 30 pages / 15 per split = 2 chapters
        Assert.Equal(2, result.Units.Count);
    }

    // QA-007: the detail page needs the document's real page count, which only the
    // extractor knows (chapter ranges stop where the last chapter does).
    [Fact]
    public async Task ExtractAsync_GeneratedPdf_MetadataCarriesPageCount()
    {
        var extractor = new PdfTextExtractor();
        var pdfBytes = PdfFixtureGenerator.GenerateMultiPagePdf(17);
        using var stream = new MemoryStream(pdfBytes);
        var request = new ExtractionRequest { Content = stream, FileName = "generated.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Equal(17, result.Metadata.PageCount);
    }

    [Fact]
    public async Task ExtractAsync_InvalidStream_PageCountNull()
    {
        var extractor = new PdfTextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("not a valid pdf"));
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.pdf" };

        var result = await extractor.ExtractAsync(request);

        Assert.Null(result.Metadata.PageCount);
    }
}
