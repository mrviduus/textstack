using Application.Common.Interfaces;
using Microsoft.Extensions.Logging;
using SkiaSharp;

namespace Infrastructure.Services;

public class ImageOptimizer : IImageOptimizer
{
    private readonly ILogger<ImageOptimizer> _logger;

    public ImageOptimizer(ILogger<ImageOptimizer> logger)
    {
        _logger = logger;
    }

    private static readonly int[] QualitySteps = [90, 75, 60, 50, 40];

    // Uploaded images are untrusted. Reading the header first refuses a
    // decompression bomb (a tiny file that decodes to gigabytes) before any pixel
    // buffer exists. 50 MP is far above any real cover or avatar.
    internal const long MaxPixels = 50_000_000;

    // CPU-bound; the interface stays async for its callers.
    public Task<OptimizedImage> OptimizeAsync(byte[] data, string mimeType, int maxSizeKb = 200, CancellationToken ct = default) =>
        Task.FromResult(Optimize(data, mimeType, maxSizeKb, ct));

    private OptimizedImage Optimize(byte[] data, string mimeType, int maxSizeKb, CancellationToken ct)
    {
        var maxBytes = maxSizeKb * 1024;

        // SVG — return as-is
        if (mimeType.Equals("image/svg+xml", StringComparison.OrdinalIgnoreCase))
            return new OptimizedImage(data, mimeType, ".svg");

        // Already small enough — keep original format
        if (data.Length <= maxBytes)
        {
            var origExt = GetExtension(mimeType);
            return new OptimizedImage(data, mimeType, origExt);
        }

        using var image = Decode(data);

        // Try WebP at decreasing quality levels
        foreach (var quality in QualitySteps)
        {
            ct.ThrowIfCancellationRequested();
            var result = EncodeWebP(image, quality);
            if (result.Length <= maxBytes)
            {
                _logger.LogDebug("Optimized {OrigSize}KB → {NewSize}KB at q{Quality}",
                    data.Length / 1024, result.Length / 1024, quality);
                return new OptimizedImage(result, "image/webp", ".webp");
            }
        }

        // Still too large — progressively resize down
        var w = image.Width;
        var h = image.Height;
        foreach (var scale in new[] { 0.75, 0.5, 0.35, 0.25 })
        {
            ct.ThrowIfCancellationRequested();
            var newW = Math.Max(1, (int)(w * scale));
            var newH = Math.Max(1, (int)(h * scale));
            using var resized = Resize(image, newW, newH);

            var result = EncodeWebP(resized, 60);
            if (result.Length <= maxBytes)
            {
                _logger.LogDebug("Optimized {OrigSize}KB → {NewSize}KB at scale {Scale}",
                    data.Length / 1024, result.Length / 1024, scale);
                return new OptimizedImage(result, "image/webp", ".webp");
            }
        }

        // Last resort: smallest size + lowest quality
        var lastW = Math.Max(1, w / 4);
        var lastH = Math.Max(1, h / 4);
        using var lastResort = Resize(image, lastW, lastH);
        var final = EncodeWebP(lastResort, 40);
        _logger.LogWarning("Image still {Size}KB after all optimization attempts (original {OrigSize}KB)",
            final.Length / 1024, data.Length / 1024);
        return new OptimizedImage(final, "image/webp", ".webp");
    }

    private static SKBitmap Decode(byte[] data)
    {
        using var codec = SKCodec.Create(new SKMemoryStream(data))
            ?? throw new InvalidDataException("Unsupported or corrupt image");
        if ((long)codec.Info.Width * codec.Info.Height > MaxPixels)
            throw new InvalidDataException(
                $"Image is {codec.Info.Width}x{codec.Info.Height}, above the {MaxPixels} pixel limit");
        return SKBitmap.Decode(codec)
            ?? throw new InvalidDataException("Unsupported or corrupt image");
    }

    private static SKBitmap Resize(SKBitmap image, int width, int height) =>
        image.Resize(new SKImageInfo(width, height, image.ColorType, image.AlphaType),
            new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear))
        ?? throw new InvalidOperationException($"Resize to {width}x{height} failed");

    private static byte[] EncodeWebP(SKBitmap image, int quality)
    {
        using var encoded = image.Encode(SKEncodedImageFormat.Webp, quality)
            ?? throw new InvalidOperationException("WebP encode failed");
        return encoded.ToArray();
    }

    private static string GetExtension(string mimeType) => mimeType switch
    {
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        _ => ".jpg"
    };
}
