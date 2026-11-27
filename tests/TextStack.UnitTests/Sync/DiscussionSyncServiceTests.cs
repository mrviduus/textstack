using Application.Common;
using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.Sync;
using Domain.Discussion;
using NSubstitute;

namespace TextStack.UnitTests.Sync;

/// <summary>A reader shares a chapter with the assistant and keeps checkpoints of the talk (v2-sync-protocol.md, M2.4 rows), on fakes.</summary>
public class DiscussionSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid Bob = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly ILibraryRepository _library = SyncFakes.Library(User, BookId, FileId);
    private ISharedChapterRepository _shares = SyncFakes.Shares();
    private ICheckpointRepository _checkpoints = SyncFakes.Checkpoints();
    private DiscussionSyncService Service => new(new BookAccess(_library), _shares, _checkpoints);

    [Fact]
    public async Task ShareAsync_ReaderSharesThenTheAppResends_IsStoredOnceAndResendsGetTheStoredShare()
    {
        var share = SyncFakes.NewShare(FileId);

        var created = await Service.ShareAsync(User, BookId, share, Ct);

        // The answer leaves out the text the app just sent (#1352).
        var dto = Assert.IsType<SharedChapterDto>(created.Body);
        Assert.Equal((201, "ch02.xhtml", null), (created.Status, dto.ChapterKey, dto.ChapterText));
        await _shares.Received(1).ShareAsync(Arg.Is<SharedChapter>(c =>
            c.UserId == User && c.BookId == BookId && c.FileId == FileId && c.NotesSnapshot == """[{ "text": "night" }]"""
            && c.PayloadSha256 == DiscussionPayloads.ShareSha256(BookId, share)), Arg.Any<CancellationToken>());

        // The same operation again (a retry) replays; its id reused for another payload is refused with what is stored.
        var stored = new SharedChapter { Id = Guid.NewGuid(), ChapterKey = "ch02.xhtml", ChapterText = "Stored text.", NotesSnapshot = "[]" };
        _shares = SyncFakes.Shares(WriteOutcome.Replayed, stored);
        var replayed = await Service.ShareAsync(User, BookId, share, Ct);
        _shares = SyncFakes.Shares(WriteOutcome.OperationConflict, stored);
        var conflict = await Service.ShareAsync(User, BookId, share with { ChapterKey = "ch03.xhtml" }, Ct);

        // A replay leaves the text out too; a conflict's stored row keeps it (the app did not send that text).
        var replayedDto = Assert.IsType<SharedChapterDto>(replayed.Body);
        Assert.Equal((200, stored.Id, null), (replayed.Status, replayedDto.Id, replayedDto.ChapterText));
        var error = SyncFakes.Error(conflict);
        var current = Assert.IsType<SharedChapterDto>(error.Current);
        Assert.Equal((409, SyncCodes.OperationConflict, stored.Id, "Stored text."), (conflict.Status, error.Code, current.Id, current.ChapterText));
    }

    [Fact]
    public async Task SaveCheckpointAsync_ReaderSavesThenTheAppResends_IsStoredOnceAndResendsGetTheStoredCheckpoint()
    {
        var checkpoint = SyncFakes.NewCheckpoint();

        var created = await Service.SaveCheckpointAsync(User, BookId, checkpoint, Ct);

        Assert.Equal(201, created.Status);
        await _checkpoints.Received(1).AppendAsync(Arg.Is<DiscussionCheckpoint>(k =>
            k.UserId == User && k.ReaderThoughts == """["It reads like a confession."]""" && k.Conclusions == "[]"
            && k.PayloadSha256 == DiscussionPayloads.CheckpointSha256(BookId, checkpoint)), Arg.Any<CancellationToken>());

        var stored = new DiscussionCheckpoint { Id = Guid.NewGuid(), Topic = "Earlier" };
        _checkpoints = SyncFakes.Checkpoints(WriteOutcome.Replayed, stored);
        var replayed = await Service.SaveCheckpointAsync(User, BookId, checkpoint, Ct);
        _checkpoints = SyncFakes.Checkpoints(WriteOutcome.OperationConflict, stored);
        var conflict = await Service.SaveCheckpointAsync(User, BookId, checkpoint with { Topic = "Later" }, Ct);
        // A checkpoint naming a share of another chapter: the repository's insert refuses it.
        _checkpoints = SyncFakes.Checkpoints(WriteOutcome.ShareMismatch);
        var mismatch = await Service.SaveCheckpointAsync(User, BookId, SyncFakes.NewCheckpoint(Guid.NewGuid()), Ct);

        Assert.Equal((200, "Earlier"), (replayed.Status, Assert.IsType<CheckpointDto>(replayed.Body).Topic));
        var error = SyncFakes.Error(conflict);
        Assert.Equal((409, SyncCodes.OperationConflict, "Earlier"), (conflict.Status, error.Code, Assert.IsType<CheckpointDto>(error.Current).Topic));
        Assert.Equal((422, SyncCodes.ShareMismatch), (mismatch.Status, SyncFakes.Error(mismatch).Code));
    }

    [Fact]
    public async Task AnotherReader_HoldingTheReadersBookAndIds_IsRefusedEverywhereAndWritesNothing()
    {
        // What the reader holds: Bob's 404s below come from the ownership check, not an unset fake.
        var shareId = Guid.NewGuid();
        _shares.GetAsync(User, shareId, Arg.Any<CancellationToken>()).Returns(new SharedChapter { Id = shareId, ChapterKey = "ch02.xhtml", NotesSnapshot = "[]" });

        (string Endpoint, SyncResult Result)[] refused =
        [
            ("share", await Service.ShareAsync(Bob, BookId, SyncFakes.NewShare(), Ct)),
            ("save checkpoint", await Service.SaveCheckpointAsync(Bob, BookId, SyncFakes.NewCheckpoint(), Ct)),
            ("list shares", await Service.ListSharesAsync(Bob, BookId, Ct)),
            ("list checkpoints", await Service.ListCheckpointsAsync(Bob, BookId, null, null, null, Ct)),
        ];
        var readShare = await Service.GetShareAsync(Bob, shareId, Ct);
        // Even the reader cannot share a file that is not a version of the book.
        var foreignFile = await Service.ShareAsync(User, BookId, SyncFakes.NewShare(Guid.NewGuid()), Ct);

        foreach (var (endpoint, result) in refused)
            Assert.Equal((endpoint, 404, SyncCodes.BookNotFound), (endpoint, result.Status, SyncFakes.Error(result).Code));
        Assert.Equal((404, SyncCodes.NotFound), (readShare.Status, SyncFakes.Error(readShare).Code));
        Assert.Equal((409, SyncCodes.UnknownFile), (foreignFile.Status, SyncFakes.Error(foreignFile).Code));
        await _shares.DidNotReceiveWithAnyArgs().ShareAsync(default!, Ct);
        await _checkpoints.DidNotReceiveWithAnyArgs().AppendAsync(default!, Ct);
        // The same ids answer the reader.
        Assert.Equal(200, (await Service.GetShareAsync(User, shareId, Ct)).Status);
    }

    [Fact]
    public async Task DeleteShareAsyncAndDeleteCheckpointAsync_DeletedTwice_Are204Then404()
    {
        var (shareId, checkpointId) = (Guid.NewGuid(), Guid.NewGuid());
        _shares.DeleteAsync(User, shareId, Arg.Any<CancellationToken>()).Returns(true, false);
        _checkpoints.DeleteAsync(User, checkpointId, Arg.Any<CancellationToken>()).Returns(true, false);

        Assert.Equal((204, 404), ((await Service.DeleteShareAsync(User, shareId, Ct)).Status, (await Service.DeleteShareAsync(User, shareId, Ct)).Status));
        Assert.Equal((204, 404), ((await Service.DeleteCheckpointAsync(User, checkpointId, Ct)).Status, (await Service.DeleteCheckpointAsync(User, checkpointId, Ct)).Status));
    }

    // A list with rows proves the book: the second round trip is only for an empty one.
    [Fact]
    public async Task ListSharesAsync_NoneThenSome_AsksForTheBookOnlyWhenEmpty()
    {
        var none = Assert.IsType<List<SharedChapterDto>>((await Service.ListSharesAsync(User, BookId, Ct)).Body);
        await _library.Received(1).ExistsAsync(User, BookId, Arg.Any<CancellationToken>());
        _library.ClearReceivedCalls();
        _shares.ListForBookAsync(User, BookId, Arg.Any<CancellationToken>())
            .Returns([new SharedChapter { Id = Guid.NewGuid(), ChapterKey = "ch02.xhtml", NotesSnapshot = "[]" }]);

        var listed = Assert.IsType<List<SharedChapterDto>>((await Service.ListSharesAsync(User, BookId, Ct)).Body);

        Assert.Equal((0, 1), (none.Count, listed.Count));
        await _library.DidNotReceiveWithAnyArgs().ExistsAsync(default, default, Ct);
    }

    [Fact]
    public async Task ListCheckpointsAsync_PageWithMoreThenLastPage_CursorResumesAfterTheLastRowAndEmptyQueryListsEveryChapter()
    {
        var last = new DiscussionCheckpoint { Id = Guid.NewGuid(), CreatedAt = new DateTimeOffset(2026, 11, 1, 10, 0, 0, TimeSpan.Zero).AddTicks(1230) };
        _checkpoints.ListAsync(User, BookId, "ch02.xhtml", 1, Arg.Any<CheckpointCursor?>(), Arg.Any<CancellationToken>())
            .Returns(new CheckpointPage([last], new CheckpointCursor(last.CreatedAt, last.Id)));

        var first = Assert.IsType<ChangeFeedDto<CheckpointDto>>((await Service.ListCheckpointsAsync(User, BookId, "ch02.xhtml", null, "1", Ct)).Body);
        await Service.ListCheckpointsAsync(User, BookId, "ch02.xhtml", first.Cursor, "1", Ct);

        Assert.True(first.HasMore);
        await _checkpoints.Received(1).ListAsync(User, BookId, "ch02.xhtml", 1, new CheckpointCursor(last.CreatedAt, last.Id), Arg.Any<CancellationToken>());
        await _library.DidNotReceiveWithAnyArgs().ExistsAsync(default, default, Ct);

        // Empty query values mean "every chapter, the default page, from the start"; the last page has no cursor.
        var lastPage = Assert.IsType<ChangeFeedDto<CheckpointDto>>((await Service.ListCheckpointsAsync(User, BookId, "", "", "", Ct)).Body);

        await _checkpoints.Received(1).ListAsync(User, BookId, null, 200, null, Arg.Any<CancellationToken>());
        Assert.Equal((null, false), (lastPage.Cursor, lastPage.HasMore));
    }

    [Theory]
    [InlineData("not-a-cursor", null, null, "cursor", "Not a cursor")]
    [InlineData(null, "0", null, "limit", "limit is 1-")]
    [InlineData(null, "501", null, "limit", "limit is 1-")]
    [InlineData(null, null, "ch\0", "chapterKey", "holds a NUL")]
    public async Task ListCheckpointsAsync_BadQuery_IsInvalidPayloadSayingWhy(string? cursor, string? limit, string? chapterKey, string field, string why)
    {
        var error = SyncFakes.Error(await Service.ListCheckpointsAsync(User, BookId, chapterKey, cursor, limit, Ct));

        Assert.Equal((SyncCodes.InvalidPayload, field), (error.Code, error.Field));
        Assert.Contains(why, error.Message);
        await _checkpoints.DidNotReceiveWithAnyArgs().ListAsync(default, default, default, default, default, Ct);
    }
}
