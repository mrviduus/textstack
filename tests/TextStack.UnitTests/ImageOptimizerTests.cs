using System.Buffers.Binary;
using System.Text;
using Infrastructure.Services;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;

namespace TextStack.UnitTests;

/// <summary>Covers and avatars go through here; uploads are untrusted input.</summary>
public class ImageOptimizerTests
{
    private static readonly ImageOptimizer Optimizer = new(NullLogger<ImageOptimizer>.Instance);

    private static byte[] NoisyPng(int w, int h)
    {
        using var bmp = new SKBitmap(w, h);
        var rnd = new Random(42);
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                bmp.SetPixel(x, y, new SKColor((byte)rnd.Next(256), (byte)rnd.Next(256), (byte)rnd.Next(256)));
        using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    [Fact]
    public async Task OptimizeAsync_SmallImage_ReturnedUnchanged()
    {
        var png = NoisyPng(8, 8);
        var result = await Optimizer.OptimizeAsync(png, "image/png", ct: TestContext.Current.CancellationToken);
        Assert.Same(png, result.Data);
        Assert.Equal(".png", result.Extension);
    }

    [Fact]
    public async Task OptimizeAsync_LargeImage_BecomesDecodableWebpUnderLimit()
    {
        var png = NoisyPng(600, 600); // noise does not compress: ~1 MB
        Assert.True(png.Length > 200 * 1024);

        var result = await Optimizer.OptimizeAsync(png, "image/png", ct: TestContext.Current.CancellationToken);

        Assert.Equal("image/webp", result.MimeType);
        Assert.True(result.Data.Length <= 200 * 1024, $"{result.Data.Length} bytes");
        using var decoded = SKBitmap.Decode(result.Data);
        Assert.NotNull(decoded);
        Assert.True(decoded.Width > 0 && decoded.Height > 0);
    }

    [Fact]
    public async Task OptimizeAsync_Tiff_IsRejected()
    {
        // TIFF is where the removed library's decoder advisories lived; Skia has no TIFF decoder.
        var tiff = new byte[] { 0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0, 0 };
        await Assert.ThrowsAsync<InvalidDataException>(() => Optimizer.OptimizeAsync(tiff, "image/tiff", maxSizeKb: 0, ct: TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task OptimizeAsync_HeaderClaimsHugeImage_RejectedBeforeDecoding()
    {
        var bomb = PngHeaderOnly(30_000, 30_000); // 900 MP; the file itself is ~45 bytes
        var ex = await Assert.ThrowsAsync<InvalidDataException>(() => Optimizer.OptimizeAsync(bomb, "image/png", maxSizeKb: 0, ct: TestContext.Current.CancellationToken));
        Assert.Contains("pixel limit", ex.Message);
    }

    // PNG signature + IHDR (8-bit RGBA) + an empty IDAT: enough for the header read.
    private static byte[] PngHeaderOnly(int w, int h)
    {
        var ms = new MemoryStream();
        ms.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, w);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), h);
        ihdr[8] = 8; ihdr[9] = 6;
        Chunk(ms, "IHDR", ihdr);
        Chunk(ms, "IDAT", []);
        return ms.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] body)
    {
        var len = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, body.Length);
        s.Write(len);
        var typed = Encoding.ASCII.GetBytes(type).Concat(body).ToArray();
        s.Write(typed);
        var crc = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32(typed));
        s.Write(crc);
    }

    private static uint Crc32(byte[] data)
    {
        var c = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            c ^= b;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        }
        return ~c;
    }
}
