using SkiaSharp;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

public class DegeneratePngTests
{
    private static byte[] Png(SKColor fill)
    {
        using var bmp = new SKBitmap(new SKImageInfo(40, 40, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        bmp.Erase(fill);
        using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    [Fact]
    public void IsDegeneratePng_FullyTransparent_True() =>
        Assert.True(PdfTextExtractor.IsDegeneratePng(Png(SKColors.Transparent)));

    [Fact]
    public void IsDegeneratePng_VisibleContent_False() =>
        Assert.False(PdfTextExtractor.IsDegeneratePng(Png(SKColors.Black)));

    [Fact]
    public void IsDegeneratePng_Undecodable_False() =>
        Assert.False(PdfTextExtractor.IsDegeneratePng([1, 2, 3, 4]));
}
