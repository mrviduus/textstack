using TextStack.Extraction.Contracts;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// A catalog edition run again (reprocess, or a job a deploy gave back) re-extracts the same images.
/// <c>book_assets</c> is unique on (edition_id, original_path), so writing them again failed the job;
/// the stored asset is reused instead, and the live chapters keep pointing at it.
/// </summary>
public class CatalogAssetReuseTests
{
    private static ExtractedImage Img(string path, bool cover = false) => new(path, [1], "image/png", cover);

    [Fact]
    public void ImagesToStore_ImageAlreadyStored_ReusesItsIdAndWritesNothing()
    {
        var storedId = Guid.NewGuid();
        var map = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);

        var toStore = IngestionWorkerService.ImagesToStore(
            [Img("images/a.png"), Img("images/b.png")],
            new Dictionary<string, Guid> { ["images/a.png"] = storedId },
            map).ToList();

        Assert.Equal(["images/b.png"], toStore.Select(i => i.OriginalPath));
        Assert.Equal(storedId, map["images/a.png"]);
    }

    [Fact]
    public void ImagesToStore_FirstRun_WritesEveryInlineImageButNotTheCover()
    {
        var map = new Dictionary<string, Guid>();

        var toStore = IngestionWorkerService.ImagesToStore(
            [Img("cover.jpg", cover: true), Img("images/a.png")], new Dictionary<string, Guid>(), map).ToList();

        Assert.Equal(["images/a.png"], toStore.Select(i => i.OriginalPath));
        Assert.Empty(map);
    }
}
