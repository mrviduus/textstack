using Api.Extensions;
using Application.Library;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;

namespace TextStack.UnitTests.V2;

/// <summary>The Api's V2 file store writes under <c>Storage:LibraryRoot</c>, never under the <c>/storage</c> static root (#1110).</summary>
public sealed class LibraryRootTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "library-root-" + Guid.NewGuid());

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task AddTextStackPersistence_LibraryRootSet_FilesUnreachableFromStaticRoot()
    {
        var storageRoot = Path.Combine(_dir, "storage");
        var libraryRoot = Path.Combine(_dir, "library");
        Directory.CreateDirectory(storageRoot);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Storage:RootPath"] = storageRoot,
            ["Storage:LibraryRoot"] = libraryRoot,
        }).Build();
        using var provider = new ServiceCollection()
            .AddSingleton<IConfiguration>(config)
            .AddTextStackPersistence("Host=unused", config)
            .BuildServiceProvider();
        var store = provider.GetRequiredService<ILibraryFileStore>();
        var key = store.FileKey(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "epub");

        var part = await store.SavePartAsync(Guid.NewGuid(), Guid.NewGuid(), 0, new MemoryStream([1]), 1, Ct);
        store.Place(await store.StageAsync(key, new byte[] { 1, 2, 3 }, Ct));

        Assert.Equal(1, part);
        Assert.Equal(Path.Combine(libraryRoot, key), store.Locate(key));
        // What /storage serves (Program.cs: PhysicalFileProvider over Storage:RootPath) holds neither the key nor the part.
        using var statics = new PhysicalFileProvider(storageRoot);
        Assert.False(statics.GetFileInfo(key).Exists);
        Assert.Empty(Directory.EnumerateFileSystemEntries(storageRoot, "*", SearchOption.AllDirectories));
    }
}
