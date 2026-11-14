using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Application.Transitional;
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
    private readonly Mock<IBookChapterRepository> _chapters = new();
    private ReadingSyncService Service => new(_library.Object, _states.Object, _sessions.Object, _chapters.Object);

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
        _states.Setup(s => s.AdvanceAsync(User, BookId, It.IsAny<ReadingState>(), It.IsAny<long?>(), It.IsAny<TransitionalChapterKeys>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(false, stored));


    [Fact]
    public async Task WriteAsync_Accepted_IsOkWithTheStoredState()
    {
        _states.Setup(s => s.AdvanceAsync(User, BookId, It.IsAny<ReadingState>(), null, It.IsAny<TransitionalChapterKeys>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(true, Stored(1)));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null), Ct);

        Assert.Equal((200, 1L), (result.Status, Assert.IsType<ReadingStateDto>(result.Body).Revision));
    }

    [Fact]
    public async Task WriteAsync_LostOnABookThatIsNotTheUsers_IsBookNotFound()
    {
        var otherBook = Guid.NewGuid();
        _states.Setup(s => s.AdvanceAsync(User, otherBook, It.IsAny<ReadingState>(), It.IsAny<long?>(), It.IsAny<TransitionalChapterKeys>(), It.IsAny<CancellationToken>()))
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

    private static JsonElement TextPosition(string chapterSlug) =>
        Json($$$"""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"{{{chapterSlug}}}","chapterFraction":0.5}}""");

    private void FileHasChapter(Guid fileId, string chapterKey) =>
        _chapters.Setup(c => c.ExistsAsync(User, fileId, chapterKey, It.IsAny<CancellationToken>())).ReturnsAsync(true);

    [Fact]
    public async Task WriteAsync_TextPosition_HandsItsChapterKeysToTheWrite()
    {
        _states.Setup(s => s.AdvanceAsync(User, BookId, It.IsAny<ReadingState>(), null, new TransitionalChapterKeys("ch-1", "ch-1"), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(true, Stored(1)));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null, TextPosition("ch-1")), Ct);

        Assert.Equal(200, result.Status);
        _chapters.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task WriteAsync_LostOnAChapterTheFileLacks_IsChapterNotFound()
    {
        Loses(null);

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null, TextPosition("no-such")), Ct);

        Assert.Equal((409, SyncCodes.ChapterNotFound), (result.Status, V2Fakes.Error(result).Code));
    }

    [Fact]
    public async Task WriteAsync_LostWithAWinningFrontierOnAChapterTheFileLacks_IsChapterNotFound()
    {
        FileHasChapter(CurrentFile, "ch-1");
        Loses(Stored(2));
        var request = Write(CurrentFile, 1, TextPosition("ch-1")) with { FrontierLocator = TextPosition("no-such"), FrontierFraction = 0.6m };

        Assert.Equal(SyncCodes.ChapterNotFound, V2Fakes.Error(await Service.WriteAsync(User, BookId, request, Ct)).Code);
    }

    // The stored frontier is ahead, so this write would not have stored its own: that chapter is not why it lost.
    [Fact]
    public async Task WriteAsync_LostWithAFrontierBehindTheStoredOneOnAMissingChapter_IsStaleRevision()
    {
        FileHasChapter(CurrentFile, "ch-1");
        var stored = Stored(2);
        (stored.FrontierLocator, stored.FrontierFraction) = (stored.CurrentLocator, 0.9m);
        Loses(stored);
        var request = Write(CurrentFile, 1, TextPosition("ch-1")) with { FrontierLocator = TextPosition("no-such"), FrontierFraction = 0.6m };

        Assert.Equal(SyncCodes.StaleRevision, V2Fakes.Error(await Service.WriteAsync(User, BookId, request, Ct)).Code);
    }

    // Any write on a superseded version is file_replaced (PDD "Reading state"), whatever its chapter.
    [Fact]
    public async Task WriteAsync_LostOnASupersededVersionWithAMissingChapter_IsFileReplaced()
    {
        Loses(Stored(5));

        var error = V2Fakes.Error(await Service.WriteAsync(User, BookId, Write(OldFile, 3, TextPosition("no-such")), Ct));

        Assert.Equal((SyncCodes.FileReplaced, CurrentFile, (long?)5), (error.Code, error.FileId, error.Revision));
    }

    [Fact]
    public async Task WriteAsync_TextPositionOnAFileThatIsNoVersionOfTheBook_IsUnknownFile()
    {
        Loses(null);

        Assert.Equal(SyncCodes.UnknownFile, V2Fakes.Error(await Service.WriteAsync(User, BookId, Write(Guid.NewGuid(), null, TextPosition("ch-1")), Ct)).Code);
    }

    [Fact]
    public async Task WriteAsync_TextPositionOnABookThatIsNotTheUsers_IsBookNotFound()
    {
        var otherBook = Guid.NewGuid();
        _states.Setup(s => s.AdvanceAsync(User, otherBook, It.IsAny<ReadingState>(), It.IsAny<long?>(), It.IsAny<TransitionalChapterKeys>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<ReadingState>(false, null));

        Assert.Equal(SyncCodes.BookNotFound, V2Fakes.Error(await Service.WriteAsync(User, otherBook, Write(CurrentFile, null, TextPosition("ch-1")), Ct)).Code);
    }

    [Fact]
    public async Task WriteAsync_LostWithPositionAndFrontierInOneChapter_AsksTheChapterOnce()
    {
        FileHasChapter(CurrentFile, "ch-1");
        Loses(Stored(2));
        var request = Write(CurrentFile, 1, TextPosition("ch-1")) with { FrontierLocator = TextPosition("ch-1"), FrontierFraction = 0.6m };

        await Service.WriteAsync(User, BookId, request, Ct);

        _chapters.Verify(c => c.ExistsAsync(User, CurrentFile, "ch-1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task WriteAsync_EpubCfiPosition_AsksNoChapter()
    {
        Loses(Stored(2));

        await Service.WriteAsync(User, BookId, Write(CurrentFile, 1), Ct);

        _chapters.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task WriteAsync_TextAnchorAsAPosition_IsInvalidPayloadAndWritesNothing()
    {
        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null,
            Json("""{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"ch-1","prefix":"","exact":"x","suffix":"","startOffset":0,"endOffset":1}}""")), Ct);

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

    // #1122: the write's SQL refuses a scheme that does not fit the file; the loss is named here, from the book's current file.
    private const string PdfPage = """{"version":1,"scheme":"pdf-page","value":{"page":2}}""";
    private const string Cfi = """{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"It was a bright cold day"}""";
    private const string TextPositionV1 = """{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.5}}""";
    private const string PageName = """{"version":1,"scheme":"page-name","value":{"page":"p02.png","index":1}}""";

    private void CurrentFileIs(string format)
    {
        _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book
        {
            Id = BookId,
            UserId = User,
            CurrentFile = new BookFile { Id = CurrentFile, BookId = BookId, Sha256 = new string('a', 64), Format = format, IsCurrent = true },
        });
        _chapters.Setup(c => c.ExistsAsync(User, CurrentFile, "ch-1", It.IsAny<CancellationToken>())).ReturnsAsync(true);
    }

    [Theory]
    [InlineData(PdfPage, "epub")]
    [InlineData(PdfPage, "html")]
    [InlineData(Cfi, "pdf")]
    [InlineData(PageName, "epub")]
    [InlineData(PageName, "pdf")]
    public async Task WriteAsync_LostOnASchemeThatDoesNotFitTheFile_IsInvalidPayload(string locator, string format)
    {
        CurrentFileIs(format);
        Loses(null);

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, null, Json(locator)), Ct);

        Assert.Equal((400, SyncCodes.InvalidPayload, "currentLocator"), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).Field));
    }

    // textstack-* fits any file: the transitional reader writes it on a PDF's reflow too.
    [Theory]
    [InlineData(PdfPage, "pdf")]
    [InlineData(Cfi, "epub")]
    [InlineData(Cfi, "html")]
    [InlineData(TextPositionV1, "epub")]
    [InlineData(TextPositionV1, "pdf")]
    [InlineData(PageName, "cbz")]
    public async Task WriteAsync_LostOnASchemeThatFitsTheFile_IsStaleRevisionNotInvalid(string locator, string format)
    {
        CurrentFileIs(format);
        Loses(Stored(2));

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, 1, Json(locator)), Ct);

        Assert.Equal((409, SyncCodes.StaleRevision), (result.Status, V2Fakes.Error(result).Code));
    }

    [Fact]
    public async Task WriteAsync_LostOnAFrontierThatDoesNotFitTheFile_IsInvalidPayloadNamingTheFrontier()
    {
        CurrentFileIs("pdf");
        Loses(null);
        var request = Write(CurrentFile, null, Json(TextPositionV1)) with { FrontierLocator = Json(Cfi), FrontierFraction = 0.6m };

        var result = await Service.WriteAsync(User, BookId, request, Ct);

        Assert.Equal((400, "frontierLocator"), (result.Status, V2Fakes.Error(result).Field));
    }
}
