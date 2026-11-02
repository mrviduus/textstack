using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using Domain.Reading;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>
/// The loss classification of v2-sync-protocol.md "The revision rule", on fakes: the repository says
/// only "lost, and here is what is stored"; this service tells a replacement from an unknown file, a
/// reset from a move.
/// </summary>
public class ReadingSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid CurrentFile = Guid.NewGuid();
    private static readonly Guid OldFile = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, CurrentFile, OldFile);
    private readonly Mock<IReadingStateRepository> _states = new();
    private readonly Mock<IReadingSessionRepository> _sessions = new();
    private ReadingSyncService Service => new(_library.Object, _states.Object, _sessions.Object);

    private static JsonElement Json(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static readonly JsonElement Position = Json("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"It was a bright cold day"}""");

    private static ReadingStateRequest Write(Guid fileId, long? expectedRevision, JsonElement? locator = null) =>
        new(expectedRevision, fileId, locator ?? Position, 0.4m, null, null, null, DateTimeOffset.UtcNow);

    private static ReadingState Stored(long revision, long? resetRevision = null) => new()
    {
        BookId = BookId,
        FileId = CurrentFile,
        CurrentLocator = Position.GetRawText(),
        BookFraction = 0.4m,
        Revision = revision,
        ResetRevision = resetRevision,
    };

    private void Loses(ReadingState? stored) =>
        _states.Setup(s => s.AdvanceAsync(User, BookId, It.IsAny<ReadingState>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(false, stored));


    [Fact]
    public async Task WriteAsync_Accepted_IsOkWithTheStoredState()
    {
        _states.Setup(s => s.AdvanceAsync(User, BookId, It.IsAny<ReadingState>(), null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(true, Stored(1)));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null), Ct);

        Assert.Equal((200, 1L), (result.Status, Assert.IsType<ReadingStateDto>(result.Body).Revision));
    }

    [Fact]
    public async Task WriteAsync_LostOnABookThatIsNotTheUsers_IsBookNotFound()
    {
        var otherBook = Guid.NewGuid();
        _states.Setup(s => s.AdvanceAsync(User, otherBook, It.IsAny<ReadingState>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(false, null));

        var result = await Service.WriteAsync(User, otherBook, Write(CurrentFile, null), Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (result.Status, V2Fakes.Error(result).Code));
    }

    [Fact]
    public async Task WriteAsync_LostNamingASupersededVersion_IsFileReplacedWithTheCurrentFile()
    {
        Loses(null); // the replacement deleted the state

        var result = await Service.WriteAsync(User, BookId, Write(OldFile, 3), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.FileReplaced, CurrentFile, CurrentFile), (result.Status, error.Code, error.FileId, error.CurrentFile!.Id));
        Assert.Null(error.Current);
    }

    [Fact]
    public async Task WriteAsync_LostNamingAFileThatIsNoVersionOfTheBook_IsUnknownFile()
    {
        Loses(null);

        var result = await Service.WriteAsync(User, BookId, Write(Guid.NewGuid(), null), Ct);

        // The PDD's example body: no file to point at.
        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.UnknownFile, (Guid?)null, (BookFileDto?)null), (result.Status, error.Code, error.FileId, error.CurrentFile));
    }

    [Fact]
    public async Task WriteAsync_LostToAResetAfterTheRevisionItRead_IsReset()
    {
        Loses(Stored(revision: 4, resetRevision: 3));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, 2), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((SyncCodes.Reset, (long?)4, CurrentFile), (error.Code, error.Revision, error.FileId));
        Assert.Equal(3L, Assert.IsType<ReadingStateDto>(error.Current).ResetRevision);
    }

    [Fact]
    public async Task WriteAsync_LostToAMoveAfterAnOlderReset_IsStaleRevision()
    {
        Loses(Stored(revision: 5, resetRevision: 3));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, 3), Ct);

        Assert.Equal((SyncCodes.StaleRevision, (long?)5), (V2Fakes.Error(result).Code, V2Fakes.Error(result).Revision));
    }

    [Fact]
    public async Task WriteAsync_FirstWriteLosingToAResetRow_IsStaleRevision()
    {
        Loses(Stored(revision: 2, resetRevision: 2)); // a first writer had no frontier to lose

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null), Ct);

        Assert.Equal(SyncCodes.StaleRevision, V2Fakes.Error(result).Code);
    }

    [Fact]
    public async Task WriteAsync_LostWithNoStoredStateOnTheCurrentFile_IsStaleRevisionWithNoCurrent()
    {
        Loses(null);

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, 7), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((SyncCodes.StaleRevision, (long?)null, (object?)null), (error.Code, error.Revision, error.Current));
    }

    [Fact]
    public async Task WriteAsync_MigratedLocatorScheme_IsInvalidPayloadAndWritesNothing()
    {
        var result = await Service.WriteAsync(User, BookId,
            Write(CurrentFile, null, Json("""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"one"}}""")), Ct);

        Assert.Equal((400, SyncCodes.InvalidPayload, "currentLocator"), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).Field));
        _states.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task WriteAsync_FrontierLocatorWithoutItsFraction_IsInvalidPayload()
    {
        var request = Write(CurrentFile, null) with { FrontierLocator = Position };

        Assert.Equal("frontierLocator", V2Fakes.Error(await Service.WriteAsync(User, BookId, request, Ct)).Field);
    }

    [Fact]
    public async Task ResetAsync_Stale_IsStaleRevisionWithTheStoredState()
    {
        _states.Setup(s => s.ResetAsync(User, BookId, 1, It.IsAny<CancellationToken>())).ReturnsAsync(new RevisionedWrite<ReadingState>(false, Stored(2)));

        var result = await Service.ResetAsync(User, BookId, new ResetReadingStateRequest(1), Ct);

        Assert.Equal((SyncCodes.StaleRevision, (long?)2), (V2Fakes.Error(result).Code, V2Fakes.Error(result).Revision));
    }

    [Fact]
    public async Task ResetAsync_NoStateOnTheUsersBook_IsNotFound()
    {
        _states.Setup(s => s.ResetAsync(User, BookId, 1, It.IsAny<CancellationToken>())).ReturnsAsync(new RevisionedWrite<ReadingState>(false, null));

        Assert.Equal(SyncCodes.NotFound, V2Fakes.Error(await Service.ResetAsync(User, BookId, new ResetReadingStateRequest(1), Ct)).Code);
    }

    [Fact]
    public async Task GetAsync_BookThatIsNotTheUsers_IsBookNotFound() =>
        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(await Service.GetAsync(User, Guid.NewGuid(), Ct)).Code);

    private static ReadingSessionRequest Session(Guid? bookId) =>
        new(bookId, DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow, 300, 120, 0.1m, 0.2m);

    [Fact]
    public async Task SaveSessionAsync_EndedBeforeItStarted_IsInvalidPayload()
    {
        var request = Session(null) with { EndedAt = DateTimeOffset.UtcNow.AddHours(-1) };

        Assert.Equal("endedAt", V2Fakes.Error(await Service.SaveSessionAsync(User, Guid.NewGuid(), request, Ct)).Field);
        _sessions.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveSessionAsync_EndedPastTheClockSkew_IsInvalidPayload()
    {
        var request = Session(null) with { EndedAt = DateTimeOffset.UtcNow.AddMinutes(6) };

        Assert.Equal("endedAt", V2Fakes.Error(await Service.SaveSessionAsync(User, Guid.NewGuid(), request, Ct)).Field);
        _sessions.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveSessionAsync_EmptyClientSessionId_IsInvalidPayload()
    {
        Assert.Equal("clientSessionId", V2Fakes.Error(await Service.SaveSessionAsync(User, Guid.Empty, Session(null), Ct)).Field);
        _sessions.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveSessionAsync_BookThatIsNotTheUsers_IsBookNotFoundAndWritesNothing()
    {
        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(await Service.SaveSessionAsync(User, Guid.NewGuid(), Session(Guid.NewGuid()), Ct)).Code);
        _sessions.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(WriteOutcome.Created, 201)]
    [InlineData(WriteOutcome.Replayed, 200)]
    public async Task SaveSessionAsync_Stored_IsCreatedFirstAndOkOnReplay(WriteOutcome outcome, int status)
    {
        _sessions.Setup(s => s.SaveAsync(User, It.IsAny<ReadingSession>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new WriteResult<ReadingSession>(outcome, new ReadingSession { BookId = BookId }));

        Assert.Equal(status, (await Service.SaveSessionAsync(User, Guid.NewGuid(), Session(BookId), Ct)).Status);
    }
}
