using System.Text.Json;
using Application.Common;
using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Discussion;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>The share and checkpoint codes of v2-sync-protocol.md (M2.4 rows), on fakes.</summary>
public class DiscussionSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, FileId);
    private readonly Mock<ISharedChapterRepository> _shares = new();
    private readonly Mock<ICheckpointRepository> _checkpoints = new();
    private DiscussionSyncService Service => new(_library.Object, _shares.Object, _checkpoints.Object);

    private static JsonElement Notes(string json = """[{ "text": "night" }]""") => JsonDocument.Parse(json).RootElement;

    private static ShareChapterRequest Share(Guid? fileId = null, Guid? operationId = null) =>
        new(operationId ?? Guid.NewGuid(), fileId, "ch02.xhtml", "Chapter II", "It was the night.", Notes(), "en");

    private static CheckpointRequest Checkpoint(Guid? sharedChapterId = null) =>
        new(Guid.NewGuid(), "The letter", ["It reads like a confession."], [], [], ["Who wrote it?"], "en", "ch02.xhtml", null, sharedChapterId);

    private void SharesWith(WriteOutcome outcome, SharedChapter? stored = null) =>
        _shares.Setup(s => s.ShareAsync(It.IsAny<SharedChapter>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((SharedChapter sent, CancellationToken _) => new WriteResult<SharedChapter>(outcome, outcome == WriteOutcome.ShareMismatch ? null : stored ?? sent));

    private void AppendsWith(WriteOutcome outcome, DiscussionCheckpoint? stored = null) =>
        _checkpoints.Setup(c => c.AppendAsync(It.IsAny<DiscussionCheckpoint>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((DiscussionCheckpoint sent, CancellationToken _) => new WriteResult<DiscussionCheckpoint>(outcome, outcome == WriteOutcome.ShareMismatch ? null : stored ?? sent));

    [Fact]
    public async Task ShareAsync_NewShare_Is201StoredAsSentUnderTheUserWithTheHashOfThatRow()
    {
        SharesWith(WriteOutcome.Created);

        var result = await Service.ShareAsync(User, BookId, Share(FileId), Ct);

        Assert.Equal(201, result.Status);
        _shares.Verify(s => s.ShareAsync(It.Is<SharedChapter>(c =>
            c.UserId == User && c.BookId == BookId && c.FileId == FileId && c.NotesSnapshot == """[{ "text": "night" }]"""
            && c.PayloadSha256 == DiscussionPayloads.ShareSha256(c)), It.IsAny<CancellationToken>()));
        Assert.Equal("ch02.xhtml", Assert.IsType<SharedChapterDto>(result.Body).ChapterKey);
    }

    [Fact]
    public async Task ShareAsync_Replay_Is200WithTheStoredShare()
    {
        var stored = new SharedChapter { Id = Guid.NewGuid(), ChapterKey = "ch02.xhtml", NotesSnapshot = "[]" };
        SharesWith(WriteOutcome.Replayed, stored);

        var result = await Service.ShareAsync(User, BookId, Share(), Ct);

        Assert.Equal((200, stored.Id), (result.Status, Assert.IsType<SharedChapterDto>(result.Body).Id));
    }

    [Fact]
    public async Task ShareAsync_OperationIdOfAnotherPayload_Is409OperationConflictWithTheStoredShare()
    {
        var stored = new SharedChapter { Id = Guid.NewGuid(), ChapterKey = "ch01.xhtml", NotesSnapshot = "[]" };
        SharesWith(WriteOutcome.OperationConflict, stored);

        var result = await Service.ShareAsync(User, BookId, Share(), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.OperationConflict, stored.Id), (result.Status, error.Code, Assert.IsType<SharedChapterDto>(error.Current).Id));
    }

    [Fact]
    public async Task ShareAsync_FileThatIsNotAVersionOfTheBook_Is409UnknownFileAndWritesNothing()
    {
        var result = await Service.ShareAsync(User, BookId, Share(Guid.NewGuid()), Ct);

        Assert.Equal((409, SyncCodes.UnknownFile), (result.Status, V2Fakes.Error(result).Code));
        _shares.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ShareAsync_BookNotTheUsers_Is404BookNotFound()
    {
        var result = await Service.ShareAsync(Guid.NewGuid(), BookId, Share(), Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (result.Status, V2Fakes.Error(result).Code));
        _shares.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ListSharesAsync_BookNotTheUsers_Is404BookNotFound()
    {
        var result = await Service.ListSharesAsync(Guid.NewGuid(), BookId, Ct);

        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(result).Code);
        _shares.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(true, 204)]
    [InlineData(false, 404)]
    public async Task DeleteShareAsync_DeletedOrNot_Is204Or404(bool deleted, int status)
    {
        var id = Guid.NewGuid();
        _shares.Setup(s => s.DeleteAsync(User, id, It.IsAny<CancellationToken>())).ReturnsAsync(deleted);

        Assert.Equal(status, (await Service.DeleteShareAsync(User, id, Ct)).Status);
    }

    [Fact]
    public async Task SaveCheckpointAsync_NewCheckpoint_Is201WithTheSectionsAsJsonArraysAndTheHashOfThatRow()
    {
        AppendsWith(WriteOutcome.Created);

        var result = await Service.SaveCheckpointAsync(User, BookId, Checkpoint(), Ct);

        Assert.Equal(201, result.Status);
        _checkpoints.Verify(c => c.AppendAsync(It.Is<DiscussionCheckpoint>(k =>
            k.UserId == User && k.ReaderThoughts == """["It reads like a confession."]""" && k.Conclusions == "[]"
            && k.PayloadSha256 == DiscussionPayloads.CheckpointSha256(k)), It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task SaveCheckpointAsync_ShareOfAnotherChapter_Is422ShareMismatch()
    {
        AppendsWith(WriteOutcome.ShareMismatch);

        var result = await Service.SaveCheckpointAsync(User, BookId, Checkpoint(Guid.NewGuid()), Ct);

        Assert.Equal((422, SyncCodes.ShareMismatch), (result.Status, V2Fakes.Error(result).Code));
    }

    [Fact]
    public async Task SaveCheckpointAsync_OperationIdOfAnotherPayload_Is409WithTheStoredCheckpoint()
    {
        var stored = new DiscussionCheckpoint { Id = Guid.NewGuid(), Topic = "Earlier" };
        AppendsWith(WriteOutcome.OperationConflict, stored);

        var result = await Service.SaveCheckpointAsync(User, BookId, Checkpoint(), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.OperationConflict, "Earlier"), (result.Status, error.Code, Assert.IsType<CheckpointDto>(error.Current).Topic));
    }

    [Fact]
    public async Task SaveCheckpointAsync_Replay_Is200()
    {
        AppendsWith(WriteOutcome.Replayed);

        Assert.Equal(200, (await Service.SaveCheckpointAsync(User, BookId, Checkpoint(), Ct)).Status);
    }

    [Fact]
    public async Task SaveCheckpointAsync_BookNotTheUsers_Is404AndWritesNothing()
    {
        var result = await Service.SaveCheckpointAsync(Guid.NewGuid(), BookId, Checkpoint(), Ct);

        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(result).Code);
        _checkpoints.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ListCheckpointsAsync_PageWithMore_HandsBackACursorThatResumesAfterItsLastRow()
    {
        var last = new DiscussionCheckpoint { Id = Guid.NewGuid(), CreatedAt = new DateTimeOffset(2026, 11, 1, 10, 0, 0, TimeSpan.Zero).AddTicks(1230) };
        CheckpointCursor? seen = null;
        _checkpoints.Setup(c => c.ListAsync(User, BookId, "ch02.xhtml", 1, It.IsAny<CheckpointCursor?>(), It.IsAny<CancellationToken>()))
            .Callback((Guid _, Guid _, string? _, int _, CheckpointCursor? after, CancellationToken _) => seen = after)
            .ReturnsAsync(new CheckpointPage([last], new CheckpointCursor(last.CreatedAt, last.Id)));

        var first = Assert.IsType<ChangeFeedDto<CheckpointDto>>((await Service.ListCheckpointsAsync(User, BookId, "ch02.xhtml", null, "1", Ct)).Body);
        await Service.ListCheckpointsAsync(User, BookId, "ch02.xhtml", first.Cursor, "1", Ct);

        Assert.True(first.HasMore);
        Assert.Equal(new CheckpointCursor(last.CreatedAt, last.Id), seen);
    }

    [Fact]
    public async Task ListCheckpointsAsync_LastPageAndEmptyQueryValues_HasNoCursorAndListsEveryChapter()
    {
        _checkpoints.Setup(c => c.ListAsync(User, BookId, null, 200, null, It.IsAny<CancellationToken>())).ReturnsAsync(new CheckpointPage([], null));

        var page = Assert.IsType<ChangeFeedDto<CheckpointDto>>((await Service.ListCheckpointsAsync(User, BookId, "", "", "", Ct)).Body);

        Assert.Equal((null, false), (page.Cursor, page.HasMore));
    }

    [Theory]
    [InlineData("not-a-cursor", null, "cursor")]
    [InlineData(null, "0", "limit")]
    [InlineData(null, "501", "limit")]
    public async Task ListCheckpointsAsync_BadQuery_IsInvalidPayloadNamingIt(string? cursor, string? limit, string field)
    {
        var result = await Service.ListCheckpointsAsync(User, BookId, null, cursor, limit, Ct);

        Assert.Equal((SyncCodes.InvalidPayload, field), (V2Fakes.Error(result).Code, V2Fakes.Error(result).Field));
    }

    [Fact]
    public async Task ListCheckpointsAsync_BookNotTheUsers_Is404BookNotFound()
    {
        var result = await Service.ListCheckpointsAsync(Guid.NewGuid(), BookId, null, null, null, Ct);

        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(result).Code);
        _checkpoints.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(true, 204)]
    [InlineData(false, 404)]
    public async Task DeleteCheckpointAsync_DeletedOrNot_Is204Or404(bool deleted, int status)
    {
        var id = Guid.NewGuid();
        _checkpoints.Setup(c => c.DeleteAsync(User, id, It.IsAny<CancellationToken>())).ReturnsAsync(deleted);

        Assert.Equal(status, (await Service.DeleteCheckpointAsync(User, id, Ct)).Status);
    }

    [Fact]
    public async Task SetCheckpointSavingAsync_UsersBook_Is200WithTheBookAsStoredNow()
    {
        _library.Setup(l => l.SetCheckpointSavingAsync(User, BookId, true, It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var result = await Service.SetCheckpointSavingAsync(User, BookId, new CheckpointSavingRequest(true), Ct);

        Assert.Equal((200, BookId), (result.Status, Assert.IsType<BookDto>(result.Body).Id));
    }

    [Fact]
    public async Task SetCheckpointSavingAsync_BookNotTheUsers_Is404BookNotFound()
    {
        var result = await Service.SetCheckpointSavingAsync(User, Guid.NewGuid(), new CheckpointSavingRequest(false), Ct);

        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(result).Code);
    }

    [Fact]
    public async Task SetCheckpointSavingAsync_NoEnabled_IsInvalidPayloadAndWritesNothing()
    {
        var result = await Service.SetCheckpointSavingAsync(User, BookId, new CheckpointSavingRequest(null), Ct);

        Assert.Equal("enabled", V2Fakes.Error(result).Field);
        _library.Verify(l => l.SetCheckpointSavingAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
