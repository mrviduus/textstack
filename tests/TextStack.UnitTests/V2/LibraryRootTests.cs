using Api.Extensions;
using Application.Library;
using Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;

namespace TextStack.UnitTests.V2;

/// <summary>
/// The V2 file store writes under <c>Storage:LibraryRoot</c>, never under the <c>/storage</c> static root,
/// and startup refuses a layout that would make it public (#1110). The Api and the Worker share
/// <see cref="FileStoreRegistration.AddTextStackFileStores"/>.
/// </summary>
public sealed class LibraryRootTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "library-root-" + Guid.NewGuid());

    private string StorageRoot => Path.Combine(_dir, "storage");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public LibraryRootTests() => Directory.CreateDirectory(StorageRoot);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private static IConfiguration Config(string? rootPath, string? libraryRoot, bool v2Api = false) =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Storage:RootPath"] = rootPath,
            ["Storage:LibraryRoot"] = libraryRoot,
            ["Features:V2Api"] = v2Api ? "true" : "false",
        }).Build();

    private static void Register(IConfiguration config) => new ServiceCollection().AddTextStackFileStores(config);

    [Fact]
    public async Task AddTextStackPersistence_LibraryRootSet_FilesUnreachableFromStaticRoot()
    {
        var libraryRoot = Path.Combine(_dir, "library");
        var config = Config(StorageRoot, libraryRoot);
        using var provider = new ServiceCollection()
            .AddSingleton(config)
            .AddTextStackPersistence("Host=unused", config)
            .BuildServiceProvider();
        var store = provider.GetRequiredService<ILibraryFileStore>();
        var key = store.FileKey(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "epub");

        var part = await store.SavePartAsync(Guid.NewGuid(), Guid.NewGuid(), 0, new MemoryStream([1]), 1, Ct);
        store.Place(await store.StageAsync(key, new byte[] { 1, 2, 3 }, Ct));

        Assert.Equal(1, part);
        Assert.Equal(Path.Combine(libraryRoot, key), store.Locate(key));
        // What /storage serves (Program.cs: PhysicalFileProvider over Storage:RootPath) holds neither the key nor the part.
        using var statics = new PhysicalFileProvider(StorageRoot);
        Assert.False(statics.GetFileInfo(key).Exists);
        Assert.Empty(Directory.EnumerateFileSystemEntries(StorageRoot, "*", SearchOption.AllDirectories));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void LibraryRoot_UnsetOrBlank_DefaultsToLibraryVolume(string? value)
    {
        var config = Config(StorageRoot, value);

        Assert.Equal("/library", FileStoreRegistration.LibraryRoot(config));
        Register(config); // /library is outside the storage root: no throw
    }

    [Theory]
    [InlineData("")]                  // the root itself
    [InlineData("/")]                 // trailing slash on the root
    [InlineData("/library")]          // the pre-#1110 layout
    [InlineData("/a/../uploads/x")]   // normalized before the check
    public void AddTextStackFileStores_LibraryRootInsideStorageRoot_Throws(string suffix)
    {
        var config = Config(StorageRoot, StorageRoot + suffix);

        var e = Assert.Throws<InvalidOperationException>(() => Register(config));
        Assert.Contains("are nested", e.Message);
    }

    [Theory]
    [InlineData("/", "/library")]                            // the public root holds everything
    [InlineData("/data/private/library", "/data/private")]   // the public root inside the library
    [InlineData("/library/storage", "/library")]
    [InlineData("/library", "/library")]                     // equal
    [InlineData("/library/", "/LIBRARY")]                    // equal up to a slash and case
    public void AddTextStackFileStores_RootsNestedEitherWay_Throws(string rootPath, string libraryRoot) =>
        Assert.Throws<InvalidOperationException>(() => Register(Config(rootPath, libraryRoot)));

    [Theory]
    [InlineData("storage", "storage-library")]
    [InlineData("storage-library", "storage")]
    [InlineData("storage", "library")]
    public void AddTextStackFileStores_SiblingRoots_Register(string rootPath, string libraryRoot)
    {
        // Under the temp dir: the file store creates its root at registration.
        var services = new ServiceCollection().AddTextStackFileStores(Config(Path.Combine(_dir, rootPath), Path.Combine(_dir, libraryRoot)));

        Assert.Contains(services, d => d.ServiceType == typeof(ILibraryFileStore));
    }

    [Theory]
    [InlineData("library/ab/abcd/1234/5678.epub")]
    [InlineData("uploads/abcd/5678/00000.part")]
    public void AddTextStackFileStores_V2OnLeftoverV2FileUnderStorageRoot_ThrowsWithMoveCommand(string leftover)
    {
        WriteLeftover(leftover);

        var e = Assert.Throws<InvalidOperationException>(() => Register(Config(StorageRoot, Path.Combine(_dir, "library"), v2Api: true)));
        Assert.Contains("mv data/storage/library data/storage/uploads data/library/", e.Message);
    }

    [Theory]
    [InlineData("library/ab/abcd/1234/5678.epub")]
    [InlineData("uploads/abcd/5678/00000.part")]
    public void AddTextStackFileStores_V2OffLeftoverV2FileUnderStorageRoot_Registers(string leftover)
    {
        WriteLeftover(leftover);

        var services = new ServiceCollection().AddTextStackFileStores(Config(StorageRoot, Path.Combine(_dir, "library")));

        Assert.Contains(services, d => d.ServiceType == typeof(ILibraryFileStore));
    }

    [Fact]
    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    public void AddTextStackFileStores_UnreadableSubdirectory_DoesNotThrow()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "unix modes");
        var locked = Path.Combine(StorageRoot, "library", "locked");
        Directory.CreateDirectory(locked);
        File.SetUnixFileMode(locked, UnixFileMode.None);
        try
        {
            Register(Config(StorageRoot, Path.Combine(_dir, "library"), v2Api: true));
        }
        finally
        {
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void StorageRoot_UnsetOrBlank_DefaultsToStorage(string? value) =>
        Assert.Equal("/storage", FileStoreRegistration.StorageRoot(Config(value, null)));

    private void WriteLeftover(string leftover)
    {
        var path = Path.Combine(StorageRoot, leftover);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "x");
    }

    [Fact]
    public void AddTextStackFileStores_EmptyLeftoverDirectories_Registers()
    {
        Directory.CreateDirectory(Path.Combine(StorageRoot, "library", "ab"));
        Directory.CreateDirectory(Path.Combine(StorageRoot, "uploads"));

        Register(Config(StorageRoot, Path.Combine(_dir, "library")));
    }
}
