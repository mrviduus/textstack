using System.IO.Compression;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Tests;

public class EpubArchiveGuardTests
{
    private static string FixturePath => Path.Combine(AppContext.BaseDirectory, "Fixtures", "minimal.epub");

    /// <summary>A zip of <paramref name="entries"/> files, each <paramref name="bytesEach"/> zero bytes (compresses to almost nothing).</summary>
    private static MemoryStream Zip(int entries, int bytesEach)
    {
        var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            var payload = new byte[bytesEach];
            for (var i = 0; i < entries; i++)
            {
                using var s = zip.CreateEntry($"f{i}.xhtml", CompressionLevel.Optimal).Open();
                s.Write(payload);
            }
        }
        ms.Position = 0;
        return ms;
    }

    [Fact]
    public void Check_RealEpub_PassesAndLeavesPositionAlone()
    {
        using var stream = File.OpenRead(FixturePath);

        Assert.Null(EpubArchiveGuard.Check(stream));
        Assert.Equal(0, stream.Position);
    }

    [Fact]
    public void Check_DeclaredSizeOverLimit_Refused()
    {
        // 1 MB of zeros deflates to ~1 KB: the small-file/huge-content shape of a zip bomb.
        using var stream = Zip(entries: 1, bytesEach: 1024 * 1024);
        Assert.True(stream.Length < 10_000);

        var error = EpubArchiveGuard.Check(stream, maxTotalBytes: 512 * 1024);

        Assert.NotNull(error);
        Assert.Equal(0, stream.Position);
    }

    [Fact]
    public void Check_SizesAddUpOverLimit_Refused()
    {
        using var stream = Zip(entries: 3, bytesEach: 400);

        Assert.Null(EpubArchiveGuard.Check(stream, maxTotalBytes: 1200));
        Assert.NotNull(EpubArchiveGuard.Check(stream, maxTotalBytes: 1199));
    }

    [Fact]
    public void Check_TooManyEntries_Refused()
    {
        using var stream = Zip(entries: 6, bytesEach: 0);

        Assert.Null(EpubArchiveGuard.Check(stream, maxEntries: 6));
        Assert.NotNull(EpubArchiveGuard.Check(stream, maxEntries: 5));
    }

    [Fact]
    public async Task ExtractAsync_ArchiveOverEntryLimit_ParseErrorNotThrow()
    {
        // Through the extractor, at the production limit: the one place both ingestion paths parse EPUBs.
        await using var stream = Zip(entries: EpubArchiveGuard.MaxEntries + 1, bytesEach: 0);
        var request = new ExtractionRequest { Content = stream, FileName = "many.epub" };

        var result = await new EpubTextExtractor().ExtractAsync(request);

        Assert.Empty(result.Units);
        var warning = Assert.Single(result.Diagnostics.Warnings);
        Assert.Equal(ExtractionWarningCode.ParseError, warning.Code);
        Assert.Contains("limit", warning.Message);
    }
}
