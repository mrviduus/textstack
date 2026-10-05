using Application.Common;
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

    [Fact]
    public async Task MoveUserBookDirectoryAsync_GuestUpload_MovesToAccountAndRebasedPathResolves()
    {
        var storage = new LocalFileStorageService(_root);
        var ct = TestContext.Current.CancellationToken;
        var (guest, account, book) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var stored = await storage.SaveUserFileAsync(guest, book, "cover.jpg", new MemoryStream([1]), ct);

        Assert.True(await storage.MoveUserBookDirectoryAsync(guest, account, book, ct));

        var rebased = UserStoragePaths.Rebase(stored,
            UserStoragePaths.BookDirectory(guest, book),
            UserStoragePaths.BookDirectory(account, book))!;
        Assert.True(await storage.ExistsAsync(rebased, ct));
        Assert.False(await storage.ExistsAsync(stored, ct));
    }

    [Fact]
    public async Task MoveUserBookDirectoryAsync_NothingStored_ReturnsFalse()
    {
        var storage = new LocalFileStorageService(_root);

        Assert.False(await storage.MoveUserBookDirectoryAsync(
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), TestContext.Current.CancellationToken));
    }
}
