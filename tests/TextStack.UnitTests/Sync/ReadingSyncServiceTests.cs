using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
using Domain.Library;
using Domain.Reading;
using NSubstitute;

namespace TextStack.UnitTests.Sync;

/// <summary>
/// A reader's place in a book, synced (v2-sync-protocol.md "The revision rule"), on fakes: the repository says
/// only "lost, and here is what is stored"; this service tells a replacement from an unknown file, a reset from a move.
/// </summary>
public class ReadingSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid CurrentFile = Guid.NewGuid();
    private static readonly Guid OldFile = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // The user has the book; its current file is CurrentFile, OldFile a superseded version of it.
    private readonly BookFile _current = new() { Id = CurrentFile, BookId = BookId, Sha256 = new string('a', 64), Format = "epub", IsCurrent = true };
    private readonly ILibraryRepository _library;
    private readonly IReadingStateRepository _states = Substitute.For<IReadingStateRepository>();
    private readonly IReadingSessionRepository _sessions = Substitute.For<IReadingSessionRepository>();
    private readonly IChapterLookup _chapters = Substitute.For<IChapterLookup>();
    private readonly SteppedClock _clock = new() { Now = new DateTimeOffset(2024, 3, 1, 12, 0, 0, TimeSpan.Zero) };

    public ReadingSyncServiceTests()
    {
        _library = SyncFakes.Library(User, BookId, _current, new BookFile { Id = OldFile, BookId = BookId, Format = "epub" });
        // A write loses with nothing stored unless a test says otherwise.
        Loses(null);
    }

    private ReadingSyncService Service => new(new BookAccess(_library), _states, _sessions, _chapters, _clock);

    private static JsonElement Json(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private const string Cfi = """{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"It was a bright cold day"}""";
    private const string PdfPage = """{"version":1,"scheme":"pdf-page","value":{"page":2}}""";
    private const string PageName = """{"version":1,"scheme":"page-name","value":{"page":"p02.png","index":1}}""";
    private const string TextPositionV1 = """{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.5}}""";
    private const string TextAnchor = """{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"ch-1","prefix":"","exact":"x","suffix":"","startOffset":0,"endOffset":1}}""";

    private static string TextPosition(string chapterSlug) =>
        $$$"""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"{{{chapterSlug}}}","chapterFraction":0.5}}""";

    private ReadingStateRequest Write(Guid fileId, long? expectedRevision, string locator = Cfi) =>
        new(expectedRevision, fileId, Json(locator), 0.4m, null, null, null, _clock.Now);

    private static ReadingState Stored(long revision, long? resetRevision = null, decimal? frontierFraction = null) => new()
    {
        BookId = BookId,
        FileId = CurrentFile,
        CurrentLocator = Cfi,
        BookFraction = 0.4m,
        FrontierLocator = frontierFraction is null ? null : Cfi,
        FrontierFraction = frontierFraction,
        Revision = revision,
        ResetRevision = resetRevision,
    };

    private void Loses(ReadingState? stored) =>
        _states.AdvanceAsync(default, default, default!, default, default!, default)
            .ReturnsForAnyArgs(new RevisionedWrite<ReadingState>(false, stored));

    // The fake reads the row live: the book, the file and its format all answer with this one.
    private void CurrentFileIs(string format) => _current.Format = format;

    private void FileHasChapter(string chapterKey) =>
        _chapters.ExistsAsync(User, CurrentFile, chapterKey, Arg.Any<CancellationToken>()).Returns(true);

    [Fact]
    public async Task WriteAsync_ReaderMovesOn_IsOkAndHandsTheChapterKeysToTheWrite()
    {
        _states.AdvanceAsync(User, BookId, Arg.Any<ReadingState>(), null, Arg.Any<TransitionalChapterKeys>(), Arg.Any<CancellationToken>())
            .Returns(new RevisionedWrite<ReadingState>(true, Stored(1)));

        var onCfi = await Service.WriteAsync(User, BookId, Write(CurrentFile, null), Ct);
        var onText = await Service.WriteAsync(User, BookId, Write(CurrentFile, null, TextPosition("ch-1")), Ct);

        Assert.Equal((200, 1L), (onCfi.Status, Assert.IsType<ReadingStateDto>(onCfi.Body).Revision));
        Assert.Equal(200, onText.Status);
        // The write's SQL guards the chapter; an accepted write never asks again.
        await _states.Received(1).AdvanceAsync(User, BookId, Arg.Any<ReadingState>(), null, new TransitionalChapterKeys("ch-1", "ch-1"), Arg.Any<CancellationToken>());
        await _chapters.DidNotReceiveWithAnyArgs().ExistsAsync(default, default, default!, Ct);
    }

    [Fact]
    public async Task WriteAsync_AnotherReadersBook_IsBookNotFoundAndStoresNoSession()
    {
        var strangers = Guid.NewGuid();
        var cfi = await Service.WriteAsync(User, strangers, Write(CurrentFile, null), Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (cfi.Status, SyncFakes.Error(cfi).Code));
        Assert.Equal(SyncCodes.BookNotFound, SyncFakes.Error(await Service.WriteAsync(User, strangers, Write(CurrentFile, null, TextPosition("ch-1")), Ct)).Code);
        Assert.Equal(SyncCodes.BookNotFound, SyncFakes.Error(await Service.GetAsync(User, strangers, Ct)).Code);
        Assert.Equal(SyncCodes.BookNotFound, SyncFakes.Error(await Service.SaveSessionAsync(User, Guid.NewGuid(), Session() with { BookId = strangers }, Ct)).Code);
        await _sessions.DidNotReceiveWithAnyArgs().SaveAsync(default, default!, Ct);
    }

    [Fact]
    public async Task WriteAsync_LostOnAFileThatIsNotTheCurrentOne_IsFileReplacedOrUnknownFile()
    {
        // The replacement deleted the state: point at the current file, nothing stored.
        var replaced = SyncFakes.Error(await Service.WriteAsync(User, BookId, Write(OldFile, 3), Ct));
        Assert.Equal((SyncCodes.FileReplaced, CurrentFile, CurrentFile, (object?)null), (replaced.Code, replaced.FileId, replaced.CurrentFile!.Id, replaced.Current));

        // A file that is no version of the book: no file to point at, whatever the locator.
        foreach (var locator in new[] { Cfi, TextPosition("ch-1") })
        {
            var result = await Service.WriteAsync(User, BookId, Write(Guid.NewGuid(), null, locator), Ct);
            var unknown = SyncFakes.Error(result);
            Assert.Equal((409, SyncCodes.UnknownFile, (Guid?)null, (BookFileDto?)null), (result.Status, unknown.Code, unknown.FileId, unknown.CurrentFile));
        }

        // Any write on a superseded version is file_replaced (PDD "Reading state"), even on a chapter it lacks.
        Loses(Stored(5));
        var withState = SyncFakes.Error(await Service.WriteAsync(User, BookId, Write(OldFile, 3, TextPosition("no-such")), Ct));
        Assert.Equal((SyncCodes.FileReplaced, CurrentFile, (long?)5), (withState.Code, withState.FileId, withState.Revision));
    }

    // A first writer (no expected revision) had no frontier to lose, so a reset is news only to a writer that read an older revision.
    [Theory]
    [InlineData(4L, 3L, 2L, SyncCodes.Reset)]           // reset after the revision it read
    [InlineData(5L, 3L, 3L, SyncCodes.StaleRevision)]   // a move after an older reset
    [InlineData(2L, 2L, null, SyncCodes.StaleRevision)] // a first write losing to a reset row
    [InlineData(null, null, 7L, SyncCodes.StaleRevision)] // nothing stored on the current file
    public async Task WriteAsync_LostToAnotherDevice_IsResetOnlyForAWriterThatReadBeforeIt(long? storedRevision, long? resetRevision, long? expectedRevision, string code)
    {
        Loses(storedRevision is { } r ? Stored(r, resetRevision) : null);

        var result = await Service.WriteAsync(User, BookId, Write(CurrentFile, expectedRevision), Ct);

        var error = SyncFakes.Error(result);
        Assert.Equal((409, code, storedRevision, CurrentFile), (result.Status, error.Code, error.Revision, error.FileId));
        if (storedRevision is null) Assert.Null(error.Current);
        else Assert.Equal(resetRevision, Assert.IsType<ReadingStateDto>(error.Current).ResetRevision);
    }

    // The write SQL's chapter guard asked again: the position's chapter, and the offered frontier's only when the write
    // would have stored it (no stored frontier, or the offered one is further). One question per distinct chapter.
    [Theory]
    [InlineData("no-such", null, null, null, SyncCodes.ChapterNotFound, 1)] // first write on a chapter the file lacks
    [InlineData("ch-1", "no-such", 2L, null, SyncCodes.ChapterNotFound, 2)] // a winning frontier on a missing chapter
    [InlineData("ch-1", "no-such", 2L, 0.9, SyncCodes.StaleRevision, 1)]    // the stored frontier is ahead: not why it lost
    [InlineData("ch-1", "ch-1", 2L, null, SyncCodes.StaleRevision, 1)]      // position and frontier in one chapter: asked once
    [InlineData(null, null, 2L, null, SyncCodes.StaleRevision, 0)]          // epub-cfi names no chapter
    public async Task WriteAsync_LostWithAChapterInPlay_IsChapterNotFoundOnlyWhenTheStoredChapterIsMissing(
        string? positionChapter, string? frontierChapter, long? storedRevision, double? storedFrontier, string code, int chapterQuestions)
    {
        FileHasChapter("ch-1");
        Loses(storedRevision is { } r ? Stored(r, frontierFraction: (decimal?)storedFrontier) : null);
        var request = Write(CurrentFile, storedRevision - 1, positionChapter is null ? Cfi : TextPosition(positionChapter));
        if (frontierChapter is not null) request = request with { FrontierLocator = Json(TextPosition(frontierChapter)), FrontierFraction = 0.6m };

        var result = await Service.WriteAsync(User, BookId, request, Ct);

        Assert.Equal((409, code), (result.Status, SyncFakes.Error(result).Code));
        await _chapters.ReceivedWithAnyArgs(chapterQuestions).ExistsAsync(default, default, default!, Ct);
        // Asked of this user, on the file the write named, by the chapter it named.
        if (positionChapter is not null) await _chapters.Received(1).ExistsAsync(User, CurrentFile, positionChapter, Arg.Any<CancellationToken>());
        if (frontierChapter is not null && frontierChapter != positionChapter && chapterQuestions == 2)
            await _chapters.Received(1).ExistsAsync(User, CurrentFile, frontierChapter, Arg.Any<CancellationToken>());
    }

    // #1122: the write's SQL refuses a scheme that does not fit the file; the loss is named here, from the book's current file.
    // textstack-* fits any file: the transitional reader writes it on a PDF's reflow too.
    [Theory]
    [InlineData(PdfPage, null, "epub", 400, "currentLocator", "The pdf-page locator does not fit this epub file.")]
    [InlineData(PdfPage, null, "html", 400, "currentLocator", "The pdf-page locator does not fit this html file.")]
    [InlineData(Cfi, null, "pdf", 400, "currentLocator", "The epub-cfi locator does not fit this pdf file.")]
    [InlineData(PageName, null, "pdf", 400, "currentLocator", "The page-name locator does not fit this pdf file.")]
    [InlineData(PageName, null, "mobi", 400, "currentLocator", "The page-name locator does not fit this mobi file.")]
    [InlineData(TextPositionV1, Cfi, "pdf", 400, "frontierLocator", "The epub-cfi locator does not fit this pdf file.")]
    [InlineData(PdfPage, null, "pdf", 409, null, null)]
    [InlineData(Cfi, null, "epub", 409, null, null)]
    [InlineData(Cfi, null, "html", 409, null, null)]
    [InlineData(TextPositionV1, null, "epub", 409, null, null)]
    [InlineData(TextPositionV1, null, "pdf", 409, null, null)]
    [InlineData(PageName, null, "cbz", 409, null, null)]
    [InlineData(PageName, null, "epub", 409, null, null)]
    public async Task WriteAsync_LostWithAScheme_IsInvalidOnlyWhenItDoesNotFitTheFile(
        string locator, string? frontier, string format, int status, string? field, string? why)
    {
        CurrentFileIs(format);
        FileHasChapter("ch-1");
        // A refused scheme is named even on a first write; a fitting one lost to a newer revision.
        var fits = status == 409;
        Loses(fits ? Stored(2) : null);
        var request = Write(CurrentFile, fits ? 1 : null, locator);
        if (frontier is not null) request = request with { FrontierLocator = Json(frontier), FrontierFraction = 0.6m };

        var result = await Service.WriteAsync(User, BookId, request, Ct);

        var error = SyncFakes.Error(result);
        Assert.Equal((status, fits ? SyncCodes.StaleRevision : SyncCodes.InvalidPayload, field), (result.Status, error.Code, error.Field));
        if (why is not null) Assert.Equal(why, error.Message);
    }

    [Theory]
    [InlineData(TextAnchor, null, null, "currentLocator", "textstack-anchor-v1 is an annotation locator only.")]
    [InlineData(Cfi, Cfi, null, "frontierLocator", "frontierLocator and frontierFraction are sent together or not at all.")]
    [InlineData(Cfi, null, 0.6, "frontierLocator", "frontierLocator and frontierFraction are sent together or not at all.")]
    public async Task WriteAsync_PayloadThatIsNoReadingPosition_IsInvalidPayloadAndWritesNothing(
        string locator, string? frontier, double? frontierFraction, string field, string why)
    {
        var request = Write(CurrentFile, null, locator) with { FrontierLocator = frontier is null ? null : Json(frontier), FrontierFraction = (decimal?)frontierFraction };

        var result = await Service.WriteAsync(User, BookId, request, Ct);

        var error = SyncFakes.Error(result);
        Assert.Equal((400, SyncCodes.InvalidPayload, field, why), (result.Status, error.Code, error.Field, error.Message));
        await _states.DidNotReceiveWithAnyArgs().AdvanceAsync(default, default, default!, default, default!, Ct);
    }

    [Fact]
    public async Task ResetAsync_StartOver_IsOkStaleOnANewerStateAndNotFoundWithNone()
    {
        _states.ResetAsync(User, BookId, 3, Arg.Any<CancellationToken>()).Returns(new RevisionedWrite<ReadingState>(true, Stored(4, resetRevision: 4)));
        _states.ResetAsync(User, BookId, 1, Arg.Any<CancellationToken>()).Returns(new RevisionedWrite<ReadingState>(false, Stored(2)));
        _states.ResetAsync(User, BookId, 9, Arg.Any<CancellationToken>()).Returns(new RevisionedWrite<ReadingState>(false, null));

        var reset = await Service.ResetAsync(User, BookId, new ResetReadingStateRequest(3), Ct);
        var stale = SyncFakes.Error(await Service.ResetAsync(User, BookId, new ResetReadingStateRequest(1), Ct));
        var none = SyncFakes.Error(await Service.ResetAsync(User, BookId, new ResetReadingStateRequest(9), Ct));

        Assert.Equal((200, 4L), (reset.Status, Assert.IsType<ReadingStateDto>(reset.Body).ResetRevision));
        Assert.Equal((SyncCodes.StaleRevision, (long?)2), (stale.Code, stale.Revision));
        Assert.Equal(SyncCodes.NotFound, none.Code);
    }

    private ReadingSessionRequest Session() =>
        new(null, _clock.Now.AddMinutes(-5), _clock.Now, 300, 120, 0.1m, 0.2m);

    // The future is the service clock's, not the machine's: the clock stands years back, so the machine would allow +6 minutes.
    [Theory]
    [InlineData(-65, false, "endedAt", "endedAt is before startedAt.")]
    [InlineData(6, false, "endedAt", "endedAt is in the future.")]
    [InlineData(0, true, "clientSessionId", "clientSessionId must be a client-minted UUID.")]
    public async Task SaveSessionAsync_SessionThatCannotHaveHappened_IsInvalidPayloadAndStoresNothing(int endedMinutesFromNow, bool emptyId, string field, string why)
    {
        var request = Session() with { EndedAt = _clock.Now.AddMinutes(endedMinutesFromNow) };

        var error = SyncFakes.Error(await Service.SaveSessionAsync(User, emptyId ? Guid.Empty : Guid.NewGuid(), request, Ct));

        Assert.Equal((field, why), (error.Field, error.Message));
        await _sessions.DidNotReceiveWithAnyArgs().SaveAsync(default, default!, Ct);
    }

    // Within the clock skew is not the future; a replay of the same session answers 200, not a second 201.
    [Theory]
    [InlineData(WriteOutcome.Created, 201)]
    [InlineData(WriteOutcome.Replayed, 200)]
    public async Task SaveSessionAsync_Stored_IsCreatedFirstAndOkOnReplay(WriteOutcome outcome, int status)
    {
        _sessions.SaveAsync(User, Arg.Any<ReadingSession>(), Arg.Any<CancellationToken>())
            .Returns(new WriteResult<ReadingSession>(outcome, new ReadingSession { BookId = BookId }));
        var request = Session() with { BookId = BookId, EndedAt = _clock.Now.AddMinutes(4) };

        Assert.Equal(status, (await Service.SaveSessionAsync(User, Guid.NewGuid(), request, Ct)).Status);
    }
}
