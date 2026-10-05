using Infrastructure.Services;

namespace TextStack.UnitTests;

public sealed class LocalFileStorageServicePathTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "ts-storage-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    [Theory]
    [InlineData("../escape.epub")]
    [InlineData("../../escape.epub")]
    [InlineData("assets/../../escape.epub")]
    [InlineData("/etc/escape.epub")]
    public async Task SaveFileAsync_NameLeavingEntityDirectory_Refused(string fileName)
    {
        var storage = new LocalFileStorageService(_root);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            storage.SaveFileAsync(Guid.NewGuid(), fileName, new MemoryStream([1]), TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<ArgumentException>(() =>
            storage.SaveUserFileAsync(Guid.NewGuid(), Guid.NewGuid(), fileName, new MemoryStream([1]), TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("book.epub")]
    [InlineData("assets/image.png")]   // TextStack import stores assets in a sub-folder
    public async Task SaveFileAsync_NameInsideEntityDirectory_Saved(string fileName)
    {
        var storage = new LocalFileStorageService(_root);

        var relative = await storage.SaveFileAsync(Guid.NewGuid(), fileName, new MemoryStream([1]), TestContext.Current.CancellationToken);

        Assert.True(File.Exists(Path.Combine(_root, relative)));
    }
}
