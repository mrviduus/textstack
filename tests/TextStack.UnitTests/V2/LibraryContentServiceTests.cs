using Application.Entitlements;
using Application.Identity;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.V2;
using Domain.Identity;
using Domain.Library;
using Domain.Transitional;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>The bytes codes of v2-sync-protocol.md "File sync upload protocol", derived on fakes.</summary>
public class LibraryContentServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid OldFileId = Guid.NewGuid();
    private const string Sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const long Limit = 10_000;
    private const string Key = "library/key.epub";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, FileId, OldFileId);
    private readonly Mock<IIngestionJobRepository> _jobs = new();
    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<ILibraryFileStore> _files = new();

    private readonly BookFile _file = new() { Id = FileId, UserId = User, BookId = BookId, Sha256 = Sha, ByteSize = 1000, Format = "epub", IsCurrent = true };
    private readonly StagedContent _staged = new(Key, "/tmp/staged", Sha, 1000);

    public LibraryContentServiceTests()
    {
        _library.Setup(l => l.GetFileAsync(User, BookId, FileId, It.IsAny<CancellationToken>())).ReturnsAsync(() => _file);
        _library.Setup(l => l.GetFileAsync(User, BookId, OldFileId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BookFile { Id = OldFileId, UserId = User, BookId = BookId, Sha256 = Sha, ByteSize = 1000, Format = "epub" });
        // A Free account whose override is the test's limit.
        _users.Setup(u => u.GetAsync(User, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new UserAccount { Id = User, Email = "reader@test", Tier = "Free", StorageLimitOverrideBytes = Limit });
        _files.Setup(f => f.PartBytes(User, FileId, It.IsAny<int>())).Returns((0L, 0L));
        _files.Setup(f => f.FileKey(User, BookId, FileId, "epub")).Returns(Key);
        _files.Setup(f => f.AssembleAsync(User, FileId, 2, Key, It.IsAny<CancellationToken>())).ReturnsAsync(() => _staged);
        _files.Setup(f => f.SavePartAsync(User, FileId, It.IsAny<int>(), It.IsAny<Stream>(), It.IsAny<long>(), It.IsAny<CancellationToken>())).ReturnsAsync(500L);
    }

    private LibraryContentService Service => new(_library.Object, _jobs.Object, _users.Object, _files.Object,
        EntitlementOptions.Empty, NullLogger<LibraryContentService>.Instance);

    private Task<SyncResult> PartAsync(int index = 0, long length = 500, Guid? fileId = null) =>
        Service.SavePartAsync(User, BookId, fileId ?? FileId, index, length, Stream.Null, maxPartBytes: 800, Ct);

    private Task<SyncResult> CompleteAsync(int? partCount = 2, Guid? fileId = null) =>
        Service.CompleteAsync(User, BookId, fileId ?? FileId, new CompleteContentRequest(partCount), Ct);

    private void Attaches(ContentAttachment result) =>
        _library.Setup(l => l.AttachContentAsync(User, BookId, FileId, Key, Limit, It.IsAny<Action>(), It.IsAny<CancellationToken>())).ReturnsAsync(result);

    private void StoresBytes(long used) => _library.Setup(l => l.StoredBytesAsync(User, It.IsAny<CancellationToken>())).ReturnsAsync(used);

    private void RemovedBook() => _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>()))
        .ReturnsAsync(new Book { Id = BookId, UserId = User, RemovedAt = DateTimeOffset.UtcNow });

    private static (int, string) Code(SyncResult result) => (result.Status, V2Fakes.Error(result).Code);

    [Theory]
    [InlineData(-1, 500)]
    [InlineData(1000, 500)]
    [InlineData(0, 801)]
    [InlineData(0, 0)]
    public async Task SavePartAsync_IndexOrLengthOutOfRange_IsInvalidPayloadAndStoresNothing(int index, long length)
    {
        Assert.Equal((400, SyncCodes.InvalidPayload), Code(await PartAsync(index, length)));
        _files.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SavePartAsync_BookNotTheUsers_IsBookNotFound() =>
        Assert.Equal((404, SyncCodes.BookNotFound), Code(await Service.SavePartAsync(User, Guid.NewGuid(), FileId, 0, 500, Stream.Null, 800, Ct)));

    [Fact]
    public async Task SavePartAsync_FileNotAVersion_IsUnknownFile() =>
        Assert.Equal((409, SyncCodes.UnknownFile), Code(await PartAsync(fileId: Guid.NewGuid())));

    [Fact]
    public async Task SavePartAsync_SupersededVersion_IsFileReplacedWithTheCurrentFile()
    {
        var result = await PartAsync(fileId: OldFileId);

        Assert.Equal((409, SyncCodes.FileReplaced, FileId), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).FileId));
    }

    [Fact]
    public async Task SavePartAsync_RemovedBook_IsBookRemoved()
    {
        RemovedBook();

        Assert.Equal((409, SyncCodes.BookRemoved), Code(await PartAsync()));
    }

    [Fact]
    public async Task SavePartAsync_PartsLongerThanTheFile_IsInvalidPayload()
    {
        _files.Setup(f => f.PartBytes(User, FileId, 1)).Returns((600L, 600L));

        Assert.Equal((400, SyncCodes.InvalidPayload), Code(await PartAsync(index: 1)));
        _files.Verify(f => f.SavePartAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<Stream>(), It.IsAny<long>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SavePartAsync_StoredAndInFlightBytesPastTheLimit_IsQuotaExceededWithUsedAndLimit()
    {
        StoresBytes(9_000);
        _files.Setup(f => f.PartBytes(User, FileId, 0)).Returns((600L, 0L));

        var result = await PartAsync(length: 500);

        Assert.Equal((413, SyncCodes.QuotaExceeded), Code(result));
        Assert.Equal(new StorageQuotaDto(9_000, Limit), V2Fakes.Error(result).Current);
        _files.Verify(f => f.SavePartAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<Stream>(), It.IsAny<long>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SavePartAsync_Fits_StoresAtMostTheDeclaredLengthAndAnswersIndexAndSize()
    {
        var result = await PartAsync(index: 3, length: 500);

        Assert.Equal((200, new UploadedPartDto(3, 500)), (result.Status, result.Body));
        // The worker sweeps stale parts; a request never deletes another upload's directory.
        _files.Verify(f => f.SweepStaleParts(It.IsAny<DateTimeOffset>()), Times.Never);
        _files.Verify(f => f.SavePartAsync(User, FileId, 3, Stream.Null, 500, It.IsAny<CancellationToken>()));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(1001)]
    public async Task CompleteAsync_PartCountOutOfRange_IsInvalidPayload(int? partCount)
    {
        var result = await CompleteAsync(partCount);

        Assert.Equal((400, "partCount"), (result.Status, V2Fakes.Error(result).Field));
    }

    [Fact]
    public async Task CompleteAsync_AlreadyStored_Is200WithoutJoiningAndEnqueuesWhenNoJobExists()
    {
        _file.ServerStorageKey = Key;

        var result = await CompleteAsync();

        Assert.Equal((200, true), (result.Status, ((BookFileDto)result.Body!).HasContent));
        _files.Verify(f => f.AssembleAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        _jobs.Verify(j => j.EnqueueAsync(User, BookId, FileId, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task CompleteAsync_AlreadyStoredWithAJob_DoesNotEnqueueAgain()
    {
        _file.ServerStorageKey = Key;
        _jobs.Setup(j => j.GetLatestForFileAsync(User, BookId, FileId, It.IsAny<CancellationToken>())).ReturnsAsync(new FileIngestionJob());

        await CompleteAsync();

        _jobs.Verify(j => j.EnqueueAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CompleteAsync_StoredButSuperseded_IsFileReplaced()
    {
        _file.ServerStorageKey = Key;
        _file.IsCurrent = false;

        Assert.Equal((409, SyncCodes.FileReplaced), Code(await CompleteAsync()));
    }

    [Fact]
    public async Task CompleteAsync_RemovedBook_IsBookRemovedBeforeJoining()
    {
        RemovedBook();

        Assert.Equal((409, SyncCodes.BookRemoved), Code(await CompleteAsync()));
        _files.Verify(f => f.AssembleAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CompleteAsync_PartMissing_IsIncompleteUploadAndThePartsStay()
    {
        _files.Setup(f => f.AssembleAsync(User, FileId, 2, Key, It.IsAny<CancellationToken>())).ReturnsAsync((StagedContent?)null);

        Assert.Equal((400, SyncCodes.IncompleteUpload), Code(await CompleteAsync()));
        _files.Verify(f => f.DeleteParts(It.IsAny<Guid>(), It.IsAny<Guid>()), Times.Never);
    }

    [Theory]
    [InlineData("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1000)]
    [InlineData(Sha, 999)]
    public async Task CompleteAsync_HashOrSizeDiffers_IsContentMismatchAndThePartsGo(string sha256, long size)
    {
        _files.Setup(f => f.AssembleAsync(User, FileId, 2, Key, It.IsAny<CancellationToken>())).ReturnsAsync(_staged with { Sha256 = sha256, ByteSize = size });

        var result = await CompleteAsync();

        Assert.Equal((422, SyncCodes.ContentMismatch), Code(result));
        Assert.Equal(new ContentMismatchDto(Sha, sha256, size), V2Fakes.Error(result).Current);
        _files.Verify(f => f.DeleteParts(User, FileId));
        _files.Verify(f => f.Discard(It.IsAny<StagedContent>()));
        _library.Verify(l => l.AttachContentAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string>(), It.IsAny<long>(), It.IsAny<Action>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CompleteAsync_Attached_Is200AndThePartsGoAndExtractionIsQueued()
    {
        Attaches(new ContentAttachment(AttachOutcome.Attached, _file));

        var result = await CompleteAsync();

        Assert.Equal(200, result.Status);
        _files.Verify(f => f.DeleteParts(User, FileId));
        _files.Verify(f => f.Discard(_staged));
        _jobs.Verify(j => j.EnqueueAsync(User, BookId, FileId, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task CompleteAsync_AttachedHtml_QueuesNoExtraction()
    {
        Attaches(new ContentAttachment(AttachOutcome.Attached, new BookFile { Id = FileId, UserId = User, BookId = BookId, Format = "html" }));

        await CompleteAsync();

        _jobs.Verify(j => j.EnqueueAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CompleteAsync_OverTheQuota_Is413WithUsedAndLimitAndThePartsGo()
    {
        Attaches(new ContentAttachment(AttachOutcome.QuotaExceeded, Used: 9_500));

        var result = await CompleteAsync();

        Assert.Equal((413, SyncCodes.QuotaExceeded), Code(result));
        Assert.Equal(new StorageQuotaDto(9_500, Limit), V2Fakes.Error(result).Current);
        _files.Verify(f => f.DeleteParts(User, FileId));
        _jobs.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CompleteAsync_ReplacedWhileJoining_IsFileReplacedAndThePartsStay()
    {
        Attaches(new ContentAttachment(AttachOutcome.FileReplaced, new BookFile { Id = OldFileId, Sha256 = Sha, Format = "epub" }));

        Assert.Equal((409, SyncCodes.FileReplaced), Code(await CompleteAsync()));
        _files.Verify(f => f.DeleteParts(It.IsAny<Guid>(), It.IsAny<Guid>()), Times.Never);
    }

    [Fact]
    public async Task ReadAsync_NoStorageKey_IsNoContent() =>
        Assert.Equal((404, SyncCodes.NoContent), Code(await Service.ReadAsync(User, BookId, FileId, Ct)));

    [Fact]
    public async Task ReadAsync_KeyWithoutBytesOnDisk_IsNoContent()
    {
        _file.ServerStorageKey = Key;

        Assert.Equal((404, SyncCodes.NoContent), Code(await Service.ReadAsync(User, BookId, FileId, Ct)));
    }

    [Theory]
    [InlineData("epub", "application/epub+zip")]
    [InlineData("pdf", "application/pdf")]
    [InlineData("html", "text/html")]
    public async Task ReadAsync_Stored_IsTheBytesWithTheFormatsContentType(string format, string contentType)
    {
        _file.ServerStorageKey = Key;
        _file.Format = format;
        _files.Setup(f => f.Locate(Key)).Returns("/volume/key");

        var result = await Service.ReadAsync(User, BookId, FileId, Ct);

        Assert.Equal(new StoredBytes("/volume/key", contentType, CacheControl: "private, no-store"), result.Body);
    }

    [Fact]
    public async Task ReadAsync_FileNotAVersion_IsUnknownFile() =>
        Assert.Equal((409, SyncCodes.UnknownFile), Code(await Service.ReadAsync(User, BookId, Guid.NewGuid(), Ct)));

    [Fact]
    public async Task RemoveAsync_Stored_ClearsTheRowThenDeletesTheKeyItCleared()
    {
        // The key the row held when it was cleared, not the one read earlier: an attach may have landed between.
        _file.ServerStorageKey = "library/read-before.epub";
        var order = new List<string>();
        _library.Setup(l => l.RemoveContentAsync(User, BookId, FileId, It.IsAny<CancellationToken>())).Callback(() => order.Add("row")).ReturnsAsync(Key);
        _files.Setup(f => f.Delete(Key)).Callback(() => order.Add("bytes"));

        var result = await Service.RemoveAsync(User, BookId, FileId, Ct);

        Assert.Equal(204, result.Status);
        Assert.Equal(["row", "bytes"], order);
        _files.Verify(f => f.Delete("library/read-before.epub"), Times.Never);
    }

    [Fact]
    public async Task RemoveAsync_NothingStored_Is204AndStampsTheRow()
    {
        var result = await Service.RemoveAsync(User, BookId, FileId, Ct);

        Assert.Equal(204, result.Status);
        _files.Verify(f => f.Delete(It.IsAny<string>()), Times.Never);
        _library.Verify(l => l.RemoveContentAsync(User, BookId, FileId, It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task RemoveAsync_BookNotTheUsers_IsBookNotFound() =>
        Assert.Equal((404, SyncCodes.BookNotFound), Code(await Service.RemoveAsync(User, Guid.NewGuid(), FileId, Ct)));

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    [Fact]
    public async Task PutCoverAsync_Png_StoresItSetsTheKeyAndDeletesAnOldCoverOfAnotherType()
    {
        _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book { Id = BookId, CoverKey = "library/cover.jpg" });
        StagesCover();
        _library.Setup(l => l.SetCoverAsync(User, BookId, "library/cover.png", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Book { Id = BookId, Title = "A book", CoverKey = "library/cover.png" });

        var result = await Service.PutCoverAsync(User, BookId, "image/png", new MemoryStream(Png), Ct);

        Assert.Equal((200, true), (result.Status, ((BookDto)result.Body!).HasCover));
        _files.Verify(f => f.StageAsync("library/cover.png", It.Is<ReadOnlyMemory<byte>>(b => b.Length == Png.Length), It.IsAny<CancellationToken>()));
        _files.Verify(f => f.Place(_cover));
        _files.Verify(f => f.Delete("library/cover.jpg"));
    }

    private readonly StagedContent _cover = new("library/cover.png", "/tmp/cover.tmp", Sha, 10);

    private void StagesCover()
    {
        _files.Setup(f => f.CoverKey(User, BookId, "png")).Returns("library/cover.png");
        _files.Setup(f => f.StageAsync("library/cover.png", It.IsAny<ReadOnlyMemory<byte>>(), It.IsAny<CancellationToken>())).ReturnsAsync(_cover);
    }

    [Fact]
    public async Task PutCoverAsync_BookGoneBeforeTheRowUpdate_IsBookNotFoundAndNothingIsPlaced()
    {
        StagesCover();

        Assert.Equal((404, SyncCodes.BookNotFound), Code(await Service.PutCoverAsync(User, BookId, "image/png", new MemoryStream(Png), Ct)));
        _files.Verify(f => f.Place(It.IsAny<StagedContent>()), Times.Never);
        _files.Verify(f => f.Discard(_cover));
    }

    [Fact]
    public async Task PutCoverAsync_TooBig_IsInvalidPayload() =>
        Assert.Equal((400, SyncCodes.InvalidPayload),
            Code(await Service.PutCoverAsync(User, BookId, "image/png", new MemoryStream(new byte[SyncLimits.MaxCoverBytes + 1]), Ct)));

    [Fact]
    public async Task PutCoverAsync_RemovedBook_IsBookRemoved()
    {
        RemovedBook();

        Assert.Equal((409, SyncCodes.BookRemoved), Code(await Service.PutCoverAsync(User, BookId, "image/png", new MemoryStream(Png), Ct)));
        _files.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("image/jpeg", new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, null)] // a PNG sent as JPEG
    [InlineData("image/jpeg", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }, "jpg")]
    [InlineData("image/png; charset=binary", new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, "png")]
    [InlineData("image/webp", new byte[] { 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50 }, "webp")]
    [InlineData("image/webp", new byte[] { 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45 }, null)] // a RIFF WAVE
    [InlineData("image/gif", new byte[] { 0x47, 0x49, 0x46, 0x38 }, null)]
    [InlineData(null, new byte[] { 0xFF, 0xD8, 0xFF }, null)]
    public void CoverExtension_DeclaredTypeAndFirstBytes_AgreeOrNull(string? contentType, byte[] bytes, string? extension) =>
        Assert.Equal(extension, LibraryContentService.CoverExtension(contentType, bytes));

    [Fact]
    public async Task GetCoverAsync_NoCover_IsNotFound() =>
        Assert.Equal((404, SyncCodes.NotFound), Code(await Service.GetCoverAsync(User, BookId, Ct)));

    [Fact]
    public async Task GetCoverAsync_KeyWithAnUnknownExtension_IsNotFoundNotAServerError()
    {
        _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book { Id = BookId, CoverKey = "library/cover.gif" });
        _files.Setup(f => f.Locate("library/cover.gif")).Returns("/volume/cover.gif");

        Assert.Equal((404, SyncCodes.NotFound), Code(await Service.GetCoverAsync(User, BookId, Ct)));
    }

    [Fact]
    public async Task GetCoverAsync_Stored_IsTheBytesWithAnETagOfTheBooksUpdatedAt()
    {
        var updatedAt = DateTimeOffset.UtcNow;
        _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book { Id = BookId, CoverKey = "library/cover.webp", UpdatedAt = updatedAt });
        _files.Setup(f => f.Locate("library/cover.webp")).Returns("/volume/cover.webp");

        var bytes = Assert.IsType<StoredBytes>((await Service.GetCoverAsync(User, BookId, Ct)).Body);

        Assert.Equal(("image/webp", $"\"{updatedAt.UtcTicks}\""), (bytes.ContentType, bytes.ETag));
    }
}
