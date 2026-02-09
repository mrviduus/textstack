using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Writer;

namespace TextStack.Extraction.Tests.Helpers;

/// <summary>
/// Generates PDF fixtures programmatically for testing.
/// </summary>
public static class PdfFixtureGenerator
{
    /// <summary>
    /// Generates a minimal valid JPEG byte array (1x1 red pixel).
    /// </summary>
    public static byte[] GenerateMinimalJpeg()
    {
        // Minimal valid JPEG: 1x1 pixel, red
        return
        [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
            0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
            0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
            0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
            0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
            0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
            0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
            0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
            0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
            0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03,
            0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D,
            0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
            0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
            0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72,
            0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
            0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45,
            0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
            0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75,
            0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3,
            0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6,
            0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9,
            0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
            0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4,
            0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01,
            0x00, 0x00, 0x3F, 0x00, 0x7B, 0x94, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xD9,
        ];
    }

    public static byte[] GeneratePdfWithJpegImage(int pageCount = 3)
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(UglyToad.PdfPig.Fonts.Standard14Fonts.Standard14Font.Helvetica);
        var jpegBytes = GenerateMinimalJpeg();

        for (var i = 1; i <= pageCount; i++)
        {
            var page = builder.AddPage(PageSize.A4);
            page.AddText($"Page {i} with image content for testing extraction.", 10,
                new UglyToad.PdfPig.Core.PdfPoint(72, 700), font);
            page.AddText("Additional text to ensure word threshold is met for processing.", 10,
                new UglyToad.PdfPig.Core.PdfPoint(72, 680), font);

            if (i == 1)
            {
                page.AddJpeg(jpegBytes,
                    new UglyToad.PdfPig.Core.PdfRectangle(72, 400, 300, 650));
            }
        }

        return builder.Build();
    }

    public static byte[] GeneratePdfWithImagesOnMultiplePages(int pageCount = 10)
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(UglyToad.PdfPig.Fonts.Standard14Fonts.Standard14Font.Helvetica);
        var jpegBytes = GenerateLargeJpeg();

        for (var i = 1; i <= pageCount; i++)
        {
            var page = builder.AddPage(PageSize.A4);
            page.AddText($"Page {i} heading text for chapter detection.", 14,
                new UglyToad.PdfPig.Core.PdfPoint(72, 750), font);
            for (var j = 0; j < 5; j++)
                page.AddText(
                    $"Line {j + 1} page {i}. Lorem ipsum dolor sit amet consectetur adipiscing elit.",
                    10, new UglyToad.PdfPig.Core.PdfPoint(72, 700 - j * 20), font);

            // Add image on every other page
            if (i % 2 == 1)
                page.AddJpeg(jpegBytes,
                    new UglyToad.PdfPig.Core.PdfRectangle(72, 300, 300, 550));
        }

        return builder.Build();
    }

    /// <summary>
    /// Generate a valid JPEG >2KB using SkiaSharp-free approach:
    /// JFIF header + large comment segment + minimal image data.
    /// </summary>
    public static byte[] GenerateLargeJpeg()
    {
        var minimal = GenerateMinimalJpeg();
        // Insert a JPEG COM (comment) marker segment after the JFIF APP0 to pad size
        // COM marker: FF FE, then 2-byte length (incl. length bytes), then data
        var commentSize = 3000;
        var comment = new byte[commentSize];
        Array.Fill(comment, (byte)0x20); // spaces
        var lenBytes = BitConverter.GetBytes((ushort)(commentSize + 2));
        if (BitConverter.IsLittleEndian)
            Array.Reverse(lenBytes);

        // Find end of APP0 segment (FF E0 + length)
        // APP0 starts at byte 2: FF E0 00 10 => length = 16, so APP0 ends at 2+2+16 = 20
        var insertAt = 20;

        using var ms = new MemoryStream();
        ms.Write(minimal, 0, insertAt);
        ms.WriteByte(0xFF);
        ms.WriteByte(0xFE); // COM marker
        ms.Write(lenBytes);
        ms.Write(comment);
        ms.Write(minimal, insertAt, minimal.Length - insertAt);
        return ms.ToArray();
    }

    public static byte[] GenerateSimplePdf(int pageCount = 3, string title = "Test PDF")
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(UglyToad.PdfPig.Fonts.Standard14Fonts.Standard14Font.Helvetica);

        for (var i = 1; i <= pageCount; i++)
        {
            var page = builder.AddPage(UglyToad.PdfPig.Content.PageSize.A4);
            page.AddText($"Page {i} of {title}", 12, new UglyToad.PdfPig.Core.PdfPoint(72, 750), font);
            page.AddText($"This is paragraph one on page {i}. It contains sample text for testing.", 10, new UglyToad.PdfPig.Core.PdfPoint(72, 700), font);
            page.AddText($"This is paragraph two on page {i}. More content follows here.", 10, new UglyToad.PdfPig.Core.PdfPoint(72, 680), font);
        }

        return builder.Build();
    }

    public static byte[] GenerateMultiPagePdf(int pageCount = 30)
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(UglyToad.PdfPig.Fonts.Standard14Fonts.Standard14Font.Helvetica);

        for (var i = 1; i <= pageCount; i++)
        {
            var page = builder.AddPage(UglyToad.PdfPig.Content.PageSize.A4);
            page.AddText($"Page {i}", 14, new UglyToad.PdfPig.Core.PdfPoint(72, 750), font);
            for (var j = 0; j < 5; j++)
            {
                page.AddText(
                    $"Line {j + 1} of page {i}. Lorem ipsum dolor sit amet consectetur adipiscing elit.",
                    10, new UglyToad.PdfPig.Core.PdfPoint(72, 700 - j * 20), font);
            }
        }

        return builder.Build();
    }

    public static byte[] GenerateEmptyPdf()
    {
        var builder = new PdfDocumentBuilder();
        builder.AddPage(UglyToad.PdfPig.Content.PageSize.A4);
        return builder.Build();
    }
}
