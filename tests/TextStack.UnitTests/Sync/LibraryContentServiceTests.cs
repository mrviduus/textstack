using Application.Identity;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
using Domain.Identity;
using Domain.Library;
using Domain.Transitional;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace TextStack.UnitTests.Sync;

/// <summary>A reader's book bytes on the server (v2-sync-protocol.md "File sync upload protocol"): parts, complete, download, stop syncing, the cover.</summary>
public class LibraryContentServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid OldFileId = Guid.NewGuid();
    private static readonly Guid NewerFileId = Guid.NewGuid();
    private const string Sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const long Limit = 10_000;
    private const string Key = "library/key.epub";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly IIngestionJobRepository _jobs = Substitute.For<IIngestionJobRepository>();
    private readonly IUserRepository _users = Substitute.For<IUserRepository>();
    private readonly ILibraryFileStore _files = Substitute.For<ILibraryFileStore>();

    private readonly BookFile _file = new() { Id = FileId, UserId = User, BookId = BookId, Sha256 = Sha, ByteSize = 1000, Format = "epub", IsCurrent = true };
    private readonly BookFile _oldFile = new() { Id = OldFileId, UserId = User, BookId = BookId, Sha256 = Sha, ByteSize = 1000, Format = "epub" };
    private readonly StagedContent _staged = new(Key, "/tmp/staged", Sha, 1000);
    private readonly ILibraryRepository _library;

    public LibraryContentServiceTests()
    {
        // The reader's book carries the file as its current one, as the library read does; OldFileId is a superseded version.
        _library = SyncFakes.Library(User, BookId, _file, _oldFile);
        // NSubstitute answers "" for strings: no file is on disk unless a test says otherwise.
        _files.Locate(default!).ReturnsForAnyArgs((string?)null);
        // A Free account whose override is the test's limit.
        _users.GetAsync(User, Arg.Any<CancellationToken>())
            .Returns(new UserAccount { Id = User, Email = "reader@test", Tier = "Free", StorageLimitOverrideBytes = Limit });
        _files.FileKey(User, BookId, FileId, Arg.Any<string>()).Returns(Key);
        _files.AssembleAsync(User, FileId, 2, Key, Arg.Any<CancellationToken>()).Returns(_ => _staged);
        _files.SavePartAsync(User, FileId, Arg.Any<int>(), Arg.Any<Stream>(), Arg.Any<long>(), Arg.Any<CancellationToken>()).Returns(500L);
    }

    private LibraryContentService Service => new(_library, _jobs, _users, _files, TestEntitlements.Options, NullLogger<LibraryContentService>.Instance);

    private Task<SyncResult> PartAsync(int index = 0, long length = 500, Guid? bookId = null, Guid? fileId = null) =>
        Service.SavePartAsync(User, bookId ?? BookId, fileId ?? FileId, index, length, Stream.Null, maxPartBytes: 800, Ct);

    private Task<SyncResult> CompleteAsync(int? partCount = 2, Guid? bookId = null, Guid? fileId = null) =>
        Service.CompleteAsync(User, bookId ?? BookId, fileId ?? FileId, new CompleteContentRequest(partCount), Ct);

    /// <summary>The attach answers <paramref name="result"/>; one that stores runs the placing of the bytes inside it, as its transaction does.</summary>
    private void Attaches(ContentAttachment result) =>
        _library.AttachContentAsync(User, BookId, FileId, Key, Limit, Arg.Any<Action>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                if (result.Outcome == AttachOutcome.Attached) call.ArgAt<Action>(5)();
                return result;
            });

    private void RemovedBook() => _library.GetAsync(User, BookId, Arg.Any<CancellationToken>())
        .Returns(new Book { Id = BookId, UserId = User, RemovedAt = DateTimeOffset.UtcNow });

    private static (int, string) Code(SyncResult result) => (result.Status, SyncFakes.Error(result).Code);

    [Theory]
    [InlineData(-1, 500, 2, "index")]
    [InlineData(1000, 500, 2, "index")]
    [InlineData(0, 0, 2, "part")]
    [InlineData(0, 801, 2, "part")]
    [InlineData(0, 500, null, "partCount")]
    [InlineData(0, 500, 0, "partCount")]
    [InlineData(0, 500, 1001, "partCount")]
    public async Task Upload_RequestOutsideItsLimits_IsInvalidPayloadAndTouchesNoBytes(int index, long length, int? partCount, string field)
    {
        var result = field == "partCount" ? await CompleteAsync(partCount) : await PartAsync(index, length);

        Assert.Equal((400, SyncCodes.InvalidPayload, field), (result.Status, SyncFakes.Error(result).Code, SyncFakes.Error(result).Field));
        Assert.Empty(_files.ReceivedCalls());
    }

    // html: a clip, extracted for the assistant tools' chapter reads (ADR-032 decided 5, amended wave 18).
    // #1128: the new formats are read on the device, never extracted.
    [Theory]
    [InlineData("epub", true)]
    [InlineData("pdf", true)]
    [InlineData("html", true)]
    [InlineData("mobi", false)]
    [InlineData("azw3", false)]
    [InlineData("fb2", false)]
    [InlineData("cbz", false)]
    public async Task UploadInParts_ReaderSendsTwoPartsAndCompletes_BytesPlacedInTheAttachAndExtractionQueuedForItsFormat(string format, bool extracted)
    {
        _file.Format = format;
        Attaches(new ContentAttachment(AttachOutcome.Attached, new BookFile { Id = FileId, UserId = User, BookId = BookId, Format = format, ServerStorageKey = Key }));
        // The first try of part 0 is cut short (the store keeps nothing); the client resends it.
        _files.SavePartAsync(User, FileId, 0, Arg.Any<Stream>(), Arg.Any<long>(), Arg.Any<CancellationToken>()).Returns((long?)null, 500L);

        var cutShort = await PartAsync(0);
        var first = await PartAsync(0);
        var second = await PartAsync(1);
        var result = await CompleteAsync();

        Assert.Equal((400, "part"), (cutShort.Status, SyncFakes.Error(cutShort).Field));
        Assert.Equal((200, new UploadedPartDto(0, 500)), (first.Status, first.Body));
        Assert.Equal((200, new UploadedPartDto(1, 500)), (second.Status, second.Body));
        Assert.Equal((200, true), (result.Status, ((BookFileDto)result.Body!).HasContent));
        // Each part stored at most its declared length; the worker, never a request, sweeps stale parts.
        await _files.Received().SavePartAsync(User, FileId, 1, Stream.Null, 500, Arg.Any<CancellationToken>());
        _files.DidNotReceiveWithAnyArgs().SweepStaleParts(default);
        // The bytes go into place inside the attach (no row without bytes), then the parts and the staging go.
        _files.Received(1).Place(_staged);
        _files.Received().DeleteParts(User, FileId);
        _files.Received().Discard(_staged);
        if (extracted) await _jobs.Received(1).EnqueueAsync(User, BookId, FileId, Arg.Any<CancellationToken>());
        else await _jobs.DidNotReceiveWithAnyArgs().EnqueueAsync(default, default, default, Ct);
    }

    [Theory]
    [InlineData("another reader's book", 404, SyncCodes.BookNotFound)]
    [InlineData("not a version of the book", 409, SyncCodes.UnknownFile)]
    [InlineData("a superseded version", 409, SyncCodes.FileReplaced)]
    [InlineData("a superseded version that has bytes", 409, SyncCodes.FileReplaced)]
    [InlineData("a removed book", 409, SyncCodes.BookRemoved)]
    public async Task Upload_TargetNotTheCurrentFileOfTheReadersLiveBook_IsRefusedBeforeAByteLands(string target, int status, string code)
    {
        var (bookId, fileId) = (BookId, FileId);
        switch (target)
        {
            case "another reader's book": bookId = Guid.NewGuid(); break;
            case "not a version of the book": fileId = Guid.NewGuid(); break;
            case "a superseded version": fileId = OldFileId; break;
            case "a superseded version that has bytes": fileId = OldFileId; _oldFile.ServerStorageKey = "library/old.epub"; break;
            case "a removed book": RemovedBook(); break;
        }

        var part = await PartAsync(bookId: bookId, fileId: fileId);
        var complete = await CompleteAsync(bookId: bookId, fileId: fileId);

        Assert.Equal((status, code), Code(part));
        Assert.Equal((status, code), Code(complete));
        // A superseded version names the book's current file, so the client knows where to upload.
        if (code == SyncCodes.FileReplaced) Assert.Equal(FileId, SyncFakes.Error(complete).FileId);
        await _files.DidNotReceiveWithAnyArgs().SavePartAsync(default, default, default, default!, default, Ct);
        await _files.DidNotReceiveWithAnyArgs().AssembleAsync(default, default, default, default!, Ct);
    }

    [Fact]
    public async Task Upload_OverTheQuota_RefusedAtThePartAndAtTheCompleteWithUsedAndLimit()
    {
        // The file is 1000 bytes: 9000 stored fits the 10000 limit exactly, one byte more does not.
        _library.StoredBytesAsync(User, Arg.Any<CancellationToken>()).Returns(9_000L, 9_001L);

        Assert.Equal(200, (await PartAsync(0)).Status);
        var refusedPart = await PartAsync(1);

        Assert.Equal((413, SyncCodes.QuotaExceeded), Code(refusedPart));
        Assert.Equal(new StorageQuotaDto(9_001, Limit), SyncFakes.Error(refusedPart).Current);
        await _files.DidNotReceive().SavePartAsync(User, FileId, 1, Arg.Any<Stream>(), Arg.Any<long>(), Arg.Any<CancellationToken>());

        // The complete decides inside the attach's transaction: the parts go, nothing is placed or queued.
        Attaches(new ContentAttachment(AttachOutcome.QuotaExceeded, Used: 9_500));
        var refusedComplete = await CompleteAsync();

        Assert.Equal((413, SyncCodes.QuotaExceeded), Code(refusedComplete));
        Assert.Equal(new StorageQuotaDto(9_500, Limit), SyncFakes.Error(refusedComplete).Current);
        _files.Received().DeleteParts(User, FileId);
        _files.DidNotReceiveWithAnyArgs().Place(default!);
        _files.Received().Discard(_staged);
        Assert.Empty(_jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData("a replay, no extraction job yet", 200, false, true, true)]
    [InlineData("a replay, its job exists", 200, false, true, false)]
    [InlineData("parts taken by a concurrent complete that stored them", 200, true, false, false)]
    [InlineData("a part missing", 400, true, false, false)] // the other parts stay for the retry
    public async Task CompleteAsync_RepeatedOrRacing_AnswersWhatTheServerHolds(string situation, int status, bool joins, bool partsGo, bool enqueues)
    {
        switch (situation)
        {
            case "a replay, no extraction job yet": _file.ServerStorageKey = Key; break;
            case "a replay, its job exists":
                _file.ServerStorageKey = Key;
                _jobs.GetLatestForFileAsync(User, BookId, FileId, Arg.Any<CancellationToken>()).Returns(new FileIngestionJob());
                break;
            case "parts taken by a concurrent complete that stored them":
                _files.AssembleAsync(User, FileId, 2, Key, Arg.Any<CancellationToken>()).Returns(_ => { _file.ServerStorageKey = Key; return (StagedContent?)null; });
                break;
            case "a part missing":
                _files.AssembleAsync(User, FileId, 2, Key, Arg.Any<CancellationToken>()).Returns((StagedContent?)null);
                break;
        }

        var result = await CompleteAsync();

        Assert.Equal(status, result.Status);
        if (status == 200) Assert.True(((BookFileDto)result.Body!).HasContent);
        else Assert.Equal(SyncCodes.IncompleteUpload, SyncFakes.Error(result).Code);
        // Nothing attaches twice; a replay never joins again and makes up for an enqueue that failed after the attach.
        await _library.DidNotReceiveWithAnyArgs().AttachContentAsync(default, default, default, default!, default, default!, Ct);
        if (joins) await _files.Received(1).AssembleAsync(User, FileId, 2, Key, Arg.Any<CancellationToken>());
        else await _files.DidNotReceiveWithAnyArgs().AssembleAsync(default, default, default, default!, Ct);
        if (partsGo) _files.Received(1).DeleteParts(User, FileId);
        else _files.DidNotReceiveWithAnyArgs().DeleteParts(default, default);
        if (enqueues) await _jobs.Received(1).EnqueueAsync(User, BookId, FileId, Arg.Any<CancellationToken>());
        else await _jobs.DidNotReceiveWithAnyArgs().EnqueueAsync(default, default, default, Ct);
    }

    [Theory]
    [InlineData("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1000)]
    [InlineData(Sha, 999)]
    public async Task CompleteAsync_JoinedBytesNotTheVersionsHashOrSize_IsContentMismatchAndNothingAttached(string sha256, long size)
    {
        var joined = _staged with { Sha256 = sha256, ByteSize = size };
        _files.AssembleAsync(User, FileId, 2, Key, Arg.Any<CancellationToken>()).Returns(joined);

        var result = await CompleteAsync();

        Assert.Equal((422, SyncCodes.ContentMismatch), Code(result));
        Assert.Equal(new ContentMismatchDto(Sha, sha256, size), SyncFakes.Error(result).Current);
        await _library.DidNotReceiveWithAnyArgs().AttachContentAsync(default, default, default, default!, default, default!, Ct);
        _files.Received().DeleteParts(User, FileId);
        _files.Received().Discard(joined);
    }

    [Theory]
    [InlineData(AttachOutcome.AlreadyStored, 200, null, true)]
    [InlineData(AttachOutcome.FileReplaced, 409, SyncCodes.FileReplaced, true)] // a superseded version is never uploadable again
    [InlineData(AttachOutcome.BookRemoved, 409, SyncCodes.BookRemoved, false)] // a restore may follow
    [InlineData(AttachOutcome.NotFound, 404, SyncCodes.BookNotFound, false)] // gone while the parts were joined
    public async Task CompleteAsync_BookChangedWhileJoining_AnswersTheChangeAndKeepsThePartsOnlyIfTheyMayBeNeeded(
        AttachOutcome outcome, int status, string? code, bool partsGo)
    {
        // The attach answers the book's current file: this one when already stored, a newer one when replaced.
        var current = outcome == AttachOutcome.FileReplaced ? NewerFileId : FileId;
        Attaches(new ContentAttachment(outcome,
            File: new BookFile { Id = current, UserId = User, BookId = BookId, Sha256 = Sha, Format = "epub", ServerStorageKey = Key },
            Book: new Book { Id = BookId, RemovedAt = DateTimeOffset.UtcNow }));

        var result = await CompleteAsync();

        Assert.Equal(status, result.Status);
        if (code is not null) Assert.Equal(code, SyncFakes.Error(result).Code);
        // A replaced file names the current one, so the client knows where to upload.
        if (code == SyncCodes.FileReplaced) Assert.Equal(NewerFileId, SyncFakes.Error(result).FileId);
        if (partsGo) _files.Received(1).DeleteParts(User, FileId);
        else _files.DidNotReceiveWithAnyArgs().DeleteParts(default, default);
        _files.Received().Discard(_staged);
        Assert.Empty(_jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData("stored", "epub", 200, "application/epub+zip")]
    [InlineData("stored", "pdf", 200, "application/pdf")]
    [InlineData("stored", "html", 200, "text/html")]
    [InlineData("stored", "mobi", 200, "application/x-mobipocket-ebook")]
    [InlineData("stored", "azw3", 200, "application/vnd.amazon.mobi8-ebook")]
    [InlineData("stored", "fb2", 200, "application/x-fictionbook+xml")]
    [InlineData("stored", "cbz", 200, "application/vnd.comicbook+zip")]
    [InlineData("never uploaded", "epub", 404, SyncCodes.NoContent)]
    [InlineData("key without bytes on disk", "epub", 404, SyncCodes.NoContent)]
    [InlineData("not a version of the book", "epub", 409, SyncCodes.UnknownFile)]
    [InlineData("another reader's book", "epub", 404, SyncCodes.BookNotFound)]
    public async Task ReadAsync_ReaderDownloadsAVersion_ItsBytesUncachedOrWhyNot(string state, string format, int status, string contentTypeOrCode)
    {
        _file.Format = format;
        var (bookId, fileId) = (BookId, FileId);
        if (state is "stored" or "key without bytes on disk") _file.ServerStorageKey = Key;
        if (state == "stored") _files.Locate(Key).Returns("/volume/key");
        if (state == "not a version of the book") fileId = Guid.NewGuid();
        if (state == "another reader's book") bookId = Guid.NewGuid();

        var result = await Service.ReadAsync(User, bookId, fileId, Ct);

        Assert.Equal(status, result.Status);
        // A reader's book: no shared cache may keep it.
        if (status == 200) Assert.Equal(new StoredBytes("/volume/key", contentTypeOrCode, CacheControl: "private, no-store"), result.Body);
        else Assert.Equal(contentTypeOrCode, SyncFakes.Error(result).Code);
    }

    [Fact]
    public async Task RemoveAsync_ReaderStopsSyncingTwice_RowClearedBeforeTheBytesItNamedAndTheRepeatIs204()
    {
        // The key the row held when cleared, not one read earlier: an attach may have landed between.
        _file.ServerStorageKey = "library/read-before.epub";
        var order = new List<string>();
        _library.RemoveContentAsync(User, BookId, FileId, Arg.Any<CancellationToken>())
            .Returns(_ => { order.Add("row"); return (string?)Key; }, _ => null);
        _files.TryDelete(Key).Returns(_ => { order.Add("bytes"); return true; });

        Assert.Equal(204, (await Service.RemoveAsync(User, BookId, FileId, Ct)).Status);
        Assert.Equal(204, (await Service.RemoveAsync(User, BookId, FileId, Ct)).Status);
        Assert.Equal((404, SyncCodes.BookNotFound), Code(await Service.RemoveAsync(User, Guid.NewGuid(), FileId, Ct)));

        Assert.Equal(["row", "bytes"], order);
        _files.Received(1).TryDelete(Arg.Any<string>());
    }

    private static readonly byte[] PngMagic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private static byte[] Image(byte[] magic, int length)
    {
        var bytes = new byte[length];
        magic.CopyTo(bytes, 0);
        return bytes;
    }

    private static byte[] Png(int length) => Image(PngMagic, length);

    private StagedContent StagesCover(string extension = "png")
    {
        var key = $"library/cover.{extension}";
        var staged = new StagedContent(key, "/tmp/cover.tmp", null, 10);
        _files.CoverKey(User, BookId, extension).Returns(key);
        _files.StageAsync(key, Arg.Any<ReadOnlyMemory<byte>>(), Arg.Any<CancellationToken>()).Returns(staged);
        return staged;
    }

    [Theory]
    [InlineData("image/png", "png", new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })]
    [InlineData("image/jpeg", "jpg", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 })]
    [InlineData("image/webp", "webp", new byte[] { 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50 })]
    public async Task PutCoverAsync_ReaderSetsThenReplacesTheCover_NewOnePlacedOnlyAnOtherOldKeyDeletedAndServedWithAnETag(
        string contentType, string extension, byte[] magic)
    {
        var key = $"library/cover.{extension}";
        var otherKey = extension == "jpg" ? "library/cover.png" : "library/cover.jpg";
        var updatedAt = DateTimeOffset.UtcNow;
        var withNewCover = new Book { Id = BookId, Title = "A book", CoverKey = key, UpdatedAt = updatedAt };
        // No cover yet, then the same key again, then a cover of another type replaced.
        _library.GetAsync(User, BookId, Arg.Any<CancellationToken>()).Returns(
            new Book { Id = BookId }, new Book { Id = BookId, CoverKey = key }, new Book { Id = BookId, CoverKey = otherKey }, withNewCover);
        var cover = StagesCover(extension);
        _library.SetCoverAsync(User, BookId, key, Arg.Any<CancellationToken>()).Returns(withNewCover);
        _files.TryDelete(otherKey).Returns(true);
        _files.Locate(key).Returns($"/volume/cover.{extension}");
        var body = Image(magic, SyncLimits.MaxCoverBytes);

        Assert.Equal(200, (await Service.PutCoverAsync(User, BookId, contentType, body.Length, new MemoryStream(body), Ct)).Status);
        Assert.Equal(200, (await Service.PutCoverAsync(User, BookId, contentType, body.Length, new MemoryStream(body), Ct)).Status);
        // The cover just placed under the same key is never deleted.
        _files.DidNotReceiveWithAnyArgs().TryDelete(default!);
        _files.ClearReceivedCalls();
        _library.ClearReceivedCalls();

        var put = await Service.PutCoverAsync(User, BookId, contentType, body.Length, new MemoryStream(body), Ct);
        var get = Assert.IsType<StoredBytes>((await Service.GetCoverAsync(User, BookId, Ct)).Body);

        Assert.Equal((200, true), (put.Status, ((BookDto)put.Body!).HasCover));
        await _files.Received(1).StageAsync(key, Arg.Is<ReadOnlyMemory<byte>>(b => b.Length == body.Length), Arg.Any<CancellationToken>());
        // Staged, then the row, then into place, then the old cover goes; the staging is cleaned up.
        Received.InOrder(() =>
        {
            _files.StageAsync(key, Arg.Any<ReadOnlyMemory<byte>>(), Arg.Any<CancellationToken>());
            _library.SetCoverAsync(User, BookId, key, Arg.Any<CancellationToken>());
            _files.Place(cover);
            _files.TryDelete(otherKey);
            _files.Discard(cover);
        });
        Assert.Equal(($"/volume/cover.{extension}", contentType, $"\"{updatedAt.UtcTicks}\""), (get.Path, get.ContentType, get.ETag));
    }

    [Theory]
    [InlineData("a declared length over the cap", 400, SyncCodes.InvalidPayload, false)]
    [InlineData("a body one byte over the cap without a length", 400, SyncCodes.InvalidPayload, false)]
    [InlineData("an empty body", 400, SyncCodes.InvalidPayload, false)]
    [InlineData("a GIF", 400, SyncCodes.InvalidPayload, false)]
    [InlineData("a removed book", 409, SyncCodes.BookRemoved, false)]
    [InlineData("another reader's book", 404, SyncCodes.BookNotFound, false)]
    [InlineData("a book deleted before the row update", 404, SyncCodes.BookNotFound, true)]
    public async Task PutCoverAsync_CoverRefused_NothingPlacedAndNothingStagedLeftBehind(string why, int status, string code, bool staged)
    {
        var (bookId, contentType, length, body) = (BookId, "image/png", (long?)null, (Stream)new MemoryStream(Png(10)));
        var cover = StagesCover();
        switch (why)
        {
            case "a declared length over the cap":
                // Refused without reading the body: a closed stream throws on any read.
                length = SyncLimits.MaxCoverBytes + 1;
                body = new MemoryStream(Png(10));
                body.Dispose();
                break;
            case "a body one byte over the cap without a length": body = new MemoryStream(Png(SyncLimits.MaxCoverBytes + 1)); break;
            case "an empty body": body = new MemoryStream(); break;
            case "a GIF": contentType = "image/gif"; body = new MemoryStream("GIF89a"u8.ToArray()); break;
            case "a removed book": RemovedBook(); break;
            case "another reader's book": bookId = Guid.NewGuid(); break;
            case "a book deleted before the row update": break; // SetCoverAsync finds no row
        }

        Assert.Equal((status, code), Code(await Service.PutCoverAsync(User, bookId, contentType, length, body, Ct)));

        _files.DidNotReceiveWithAnyArgs().Place(default!);
        if (staged)
        {
            await _files.Received(1).StageAsync(cover.Key, Arg.Any<ReadOnlyMemory<byte>>(), Arg.Any<CancellationToken>());
            _files.Received(1).Discard(cover);
        }
        else
        {
            await _files.DidNotReceiveWithAnyArgs().StageAsync(default!, default, Ct);
            _files.DidNotReceiveWithAnyArgs().Discard(default!);
        }
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

    [Theory]
    [InlineData("no cover", SyncCodes.NotFound)]
    [InlineData("a key with an unknown extension", SyncCodes.NotFound)]
    [InlineData("a key without bytes on disk", SyncCodes.NotFound)]
    [InlineData("another reader's book", SyncCodes.BookNotFound)]
    public async Task GetCoverAsync_NoStoredCover_Is404NotAServerError(string state, string code)
    {
        var bookId = state == "another reader's book" ? Guid.NewGuid() : BookId;
        var key = state switch { "a key with an unknown extension" => "library/cover.gif", "a key without bytes on disk" => "library/cover.png", _ => null };
        _library.GetAsync(User, BookId, Arg.Any<CancellationToken>()).Returns(new Book { Id = BookId, CoverKey = key });
        _files.Locate("library/cover.gif").Returns("/volume/cover.gif");

        Assert.Equal((404, code), Code(await Service.GetCoverAsync(User, bookId, Ct)));
    }
}
