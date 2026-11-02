using System.Security.Cryptography;
using Application.Library;
using Infrastructure.Services;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests.V2;

/// <summary><see cref="LibraryFileStore"/> on a temp directory: parts, the join and its hash, placing, the sweeps.</summary>
public sealed class LibraryFileStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "library-store-" + Guid.NewGuid());
    private readonly LibraryFileStore _store;
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public LibraryFileStoreTests() => _store = new LibraryFileStore(_root);

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string Key => _store.FileKey(User, BookId, FileId, "epub");

    private Task<long?> PartAsync(int index, byte[] bytes, Guid? fileId = null, long maxBytes = 1024) =>
        _store.SavePartAsync(User, fileId ?? FileId, index, new MemoryStream(bytes), maxBytes, Ct);

    private string UploadDir => Path.Combine(_root, "uploads", User.ToString(), FileId.ToString());

    [Fact]
    public void FileKey_Ids_AreThePlanLayoutUnderLibrary()
    {
        var u = User.ToString();

        Assert.Equal($"library/{u[..2]}/{u}/{BookId}/{FileId}.pdf", _store.FileKey(User, BookId, FileId, "pdf"));
        Assert.Equal($"library/{u[..2]}/{u}/{BookId}/cover.png", _store.CoverKey(User, BookId, "png"));
    }

    [Fact]
    public async Task SavePartAsync_BodyLongerThanTheCap_KeepsNothing()
    {
        Assert.Null(await PartAsync(0, new byte[11], maxBytes: 10));
        Assert.Null(await PartAsync(1, []));

        Assert.Empty(Directory.EnumerateFiles(UploadDir));
    }

    [Fact]
    public async Task AssembleAsync_TwoParts_HashesTheJoinedBytesAndPlaceMovesThemToTheKey()
    {
        await PartAsync(0, [1, 2, 3]);
        await PartAsync(1, [4, 5]);

        var staged = (await _store.AssembleAsync(User, FileId, 2, Key, Ct))!;
        _store.Place(staged);

        Assert.Equal((Convert.ToHexStringLower(SHA256.HashData([1, 2, 3, 4, 5])), 5L), (staged.Sha256, staged.ByteSize));
        Assert.Equal([1, 2, 3, 4, 5], await File.ReadAllBytesAsync(_store.Locate(Key)!, Ct));
        Assert.False(File.Exists(staged.TempPath));
        Assert.Equal(2, Directory.EnumerateFiles(UploadDir).Count());
    }

    [Fact]
    public async Task AssembleAsync_ReSentPart_JoinsTheLastAttempt()
    {
        await PartAsync(0, [9, 9]);
        await PartAsync(0, [1]);

        var staged = (await _store.AssembleAsync(User, FileId, 1, Key, Ct))!;

        Assert.Equal(1L, staged.ByteSize);
    }

    [Fact]
    public async Task AssembleAsync_PartMissing_NullAndThePartsStay()
    {
        await PartAsync(0, [1]);
        await PartAsync(2, [3]);

        Assert.Null(await _store.AssembleAsync(User, FileId, 3, Key, Ct));

        Assert.Equal(2, Directory.EnumerateFiles(UploadDir).Count());
        Assert.Null(_store.Locate(Key));
        Assert.False(Directory.Exists(Path.GetDirectoryName(Path.Combine(_root, Key))));
    }

    [Fact]
    public async Task Discard_StagedFile_IsDeletedAndNothingIsPlaced()
    {
        await PartAsync(0, [1]);
        var staged = (await _store.AssembleAsync(User, FileId, 1, Key, Ct))!;

        _store.Discard(staged);

        Assert.False(File.Exists(staged.TempPath));
        Assert.Null(_store.Locate(Key));
    }

    [Fact]
    public async Task PartBytes_UserAndFile_CountEveryPartButTheOneBeingResent()
    {
        var other = Guid.NewGuid();
        await PartAsync(0, new byte[10]);
        await PartAsync(1, new byte[20]);
        await PartAsync(0, new byte[40], other);

        Assert.Equal((60L, 20L), _store.PartBytes(User, FileId, exceptIndex: 0));
        Assert.Equal((0L, 0L), _store.PartBytes(Guid.NewGuid(), FileId, 0));
    }

    [Fact]
    public async Task SweepStaleParts_UploadUntouchedForADay_IsDeletedAFreshOneStays()
    {
        var other = Guid.NewGuid();
        await PartAsync(0, [1]);
        await PartAsync(0, [1], other);
        Directory.SetLastWriteTimeUtc(UploadDir, DateTime.UtcNow.AddDays(-2));

        _store.SweepStaleParts(DateTimeOffset.UtcNow);

        Assert.False(Directory.Exists(UploadDir));
        Assert.Equal((1L, 1L), _store.PartBytes(User, other, -1));
    }

    [Fact]
    public async Task WriteAsync_SameKeyTwice_TheSecondReplacesTheFirst()
    {
        var key = _store.CoverKey(User, BookId, "png");

        await _store.WriteAsync(key, new byte[] { 1, 2 }, Ct);
        await _store.WriteAsync(key, new byte[] { 3 }, Ct);

        Assert.Equal([3], await File.ReadAllBytesAsync(_store.Locate(key)!, Ct));
    }

    [Fact]
    public async Task Delete_StoredAndAbsentKey_RemovesTheBytesAndDoesNotThrow()
    {
        await _store.WriteAsync(Key, new byte[] { 1 }, Ct);

        _store.Delete(Key);
        _store.Delete(_store.FileKey(Guid.NewGuid(), BookId, FileId, "pdf"));

        Assert.Null(_store.Locate(Key));
    }

    [Fact]
    public async Task DeleteUser_LibraryAndParts_AreGoneAnotherUsersStay()
    {
        var otherKey = _store.FileKey(Guid.NewGuid(), BookId, FileId, "epub");
        await _store.WriteAsync(Key, new byte[] { 1 }, Ct);
        await _store.WriteAsync(otherKey, new byte[] { 1 }, Ct);
        await PartAsync(0, [1]);

        _store.DeleteUser(User);

        Assert.Null(_store.Locate(Key));
        Assert.False(Directory.Exists(UploadDir));
        Assert.NotNull(_store.Locate(otherKey));
    }

    [Fact]
    public void RootOf_NoLibraryRoot_IsLibraryUnderTheStorageRoot()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:RootPath"] = "/data/storage" }).Build();

        Assert.Equal(Path.Combine("/data/storage", "library"), LibraryFileStore.RootOf(config));
    }
}
