using Application.UserBooks;

namespace TextStack.UnitTests;

/// <summary>
/// Books over Cloudflare's single-request ceiling (~100 MB → 413 before the API) arrive as parts. The store
/// must join them in index order, refuse to complete with a gap, cap each part, and accept a retried part.
/// </summary>
public sealed class ChunkedUploadStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "chunked-upload-tests-" + Guid.NewGuid().ToString("N"));
    private readonly ChunkedUploadStore _store;
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid Upload = Guid.NewGuid();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    public ChunkedUploadStoreTests() => _store = new ChunkedUploadStore(_root);

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private Task<long?> Save(int index, string content, long max = 1024) =>
        _store.SavePartAsync(User, Upload, index, new MemoryStream(System.Text.Encoding.ASCII.GetBytes(content)), max, _ct);

    private static string ReadAll(Stream s) => new StreamReader(s).ReadToEnd();

    [Fact]
    public async Task AssembleAsync_PartsSentOutOfOrder_JoinsByIndex()
    {
        await Save(1, "BB");
        await Save(0, "AA");
        await Save(2, "C");

        await using var file = await _store.AssembleAsync(User, Upload, 3, _ct);

        Assert.NotNull(file);
        Assert.True(file.CanSeek);
        Assert.Equal(5, file.Length);
        Assert.Equal("AABBC", ReadAll(file));
    }

    [Fact]
    public async Task AssembleAsync_MissingPart_ReturnsNullAndKeepsParts()
    {
        await Save(0, "AA");
        await Save(2, "C");

        Assert.Null(await _store.AssembleAsync(User, Upload, 3, _ct));
        Assert.Equal(3, _store.StoredBytes(User, Upload));
    }

    [Fact]
    public async Task AssembleAsync_Done_RemovesParts()
    {
        await Save(0, "AA");
        await using (var file = await _store.AssembleAsync(User, Upload, 1, _ct)) Assert.NotNull(file);

        Assert.Equal(0, _store.StoredBytes(User, Upload));
    }

    [Fact]
    public async Task SavePartAsync_OverCeiling_RefusedAndNothingKept()
    {
        Assert.Null(await Save(0, "ABCDE", max: 4));
        Assert.Equal(0, _store.StoredBytes(User, Upload));
    }

    [Fact]
    public async Task SavePartAsync_Retried_ReplacesEarlierAttempt()
    {
        await Save(0, "AAAA");
        Assert.Equal(2, await Save(0, "ZZ"));

        Assert.Equal(2, _store.StoredBytes(User, Upload));
        Assert.Equal(0, _store.StoredBytes(User, Upload, exceptIndex: 0));
    }

    [Fact]
    public async Task SavePartAsync_IndexOutOfRange_Refused() =>
        Assert.Null(await Save(ChunkedUploadStore.MaxParts, "A"));

    [Fact]
    public async Task StoredBytes_OtherUser_SeesNothing()
    {
        await Save(0, "AA");
        Assert.Equal(0, _store.StoredBytes(Guid.NewGuid(), Upload));
    }
}
