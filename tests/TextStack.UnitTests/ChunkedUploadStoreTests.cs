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
        Assert.Equal(3, _store.UploadBytes(User, Upload));
    }

    [Fact]
    public async Task AssembleAsync_Done_RemovesParts()
    {
        await Save(0, "AA");
        await using (var file = await _store.AssembleAsync(User, Upload, 1, _ct)) Assert.NotNull(file);

        Assert.Equal(0, _store.UploadBytes(User, Upload));
    }

    [Fact]
    public async Task SavePartAsync_OverCeiling_RefusedAndNothingKept()
    {
        Assert.Null(await Save(0, "ABCDE", max: 4));
        Assert.Equal(0, _store.UploadBytes(User, Upload));
    }

    [Fact]
    public async Task SavePartAsync_Retried_ReplacesEarlierAttempt()
    {
        await Save(0, "AAAA");
        Assert.Equal(2, await Save(0, "ZZ"));

        Assert.Equal(2, _store.UploadBytes(User, Upload));
        Assert.Equal(0, _store.UploadBytes(User, Upload, exceptIndex: 0));
    }

    [Fact]
    public async Task SavePartAsync_IndexOutOfRange_Refused() =>
        Assert.Null(await Save(ChunkedUploadStore.MaxParts, "A"));

    [Fact]
    public async Task UserBytes_ParallelUploads_CountsAllOfThem()
    {
        await Save(0, "AA");
        await _store.SavePartAsync(User, Guid.NewGuid(), 0, new MemoryStream("BBB"u8.ToArray()), 1024, _ct);

        Assert.Equal(5, _store.UserBytes(User, Upload, exceptIndex: -1));
        Assert.Equal(3, _store.UserBytes(User, Upload, exceptIndex: 0));
    }

    [Fact]
    public async Task AssembleAsync_SecondCompleteForSameUpload_GetsNothing()
    {
        await Save(0, "AA");

        await using var first = await _store.AssembleAsync(User, Upload, 1, _ct);
        await using var second = await _store.AssembleAsync(User, Upload, 1, _ct);

        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Fact]
    public async Task AssembleAsync_Disposed_LeavesNothingOnDisk()
    {
        await Save(0, "AA");
        await (await _store.AssembleAsync(User, Upload, 1, _ct))!.DisposeAsync();

        Assert.Equal(0, _store.UserBytes(User, Upload, exceptIndex: -1));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(_root, User.ToString("N"))));
    }

    [Fact]
    public async Task SavePartAsync_ClientAbortsMidPart_KeepsNothing()
    {
        await Assert.ThrowsAsync<IOException>(() =>
            _store.SavePartAsync(User, Upload, 0, new FailingStream(), 1024, _ct));

        Assert.Equal(0, _store.UserBytes(User, Upload, exceptIndex: -1));
    }

    private sealed class FailingStream : MemoryStream
    {
        private int _reads;
        public FailingStream() : base("ABC"u8.ToArray()) { }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
            _reads++ == 0 ? base.ReadAsync(buffer, ct) : throw new IOException("client went away");
    }

    [Fact]
    public async Task UserBytes_OtherUser_SeesNothing()
    {
        await Save(0, "AA");
        Assert.Equal(0, _store.UserBytes(Guid.NewGuid(), Upload, exceptIndex: -1));
    }
}
