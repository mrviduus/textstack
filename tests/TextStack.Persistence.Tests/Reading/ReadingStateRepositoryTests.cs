using Application.Transitional;
using Dapper;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.TestJson;

namespace TextStack.Persistence.Tests.Reading;

public class ReadingStateRepositoryTests(V2PostgresFixture db)
{
    private readonly ReadingStateRepository _repo = new(db.DataSource);
    private readonly LibraryRepository _library = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A position on page <paramref name="page"/> of 10, with no frontier offered.</summary>
    private static ReadingState At(Guid fileId, int page) => new()
    {
        FileId = fileId,
        CurrentLocator = Cfi(page),
        BookFraction = page / 10m,
        ClientRecordedAt = DateTimeOffset.UtcNow,
    };

    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithBookAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        return (book.UserId, book.Id, book.CurrentFile!.Id);
    }

    // Transitional (M2.7a): the chapter guard of a textstack-* write, in the statement itself.
    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithChapterAsync(string key = "ch-1")
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await new BookChapterRepository(db.DataSource).ReplaceForFileAsync(user, book, file,
            [new() { Id = Guid.NewGuid(), ChapterKey = key, ChapterNumber = 1, Title = key, Html = "<p/>", PlainText = "", WordCount = 0 }], Ct);
        return (user, book, file);
    }

    private static readonly TransitionalChapterKeys OnChapter = new("ch-1", "ch-1");

    private static ReadingState WithFrontier(Guid fileId, int page, int frontierPage) =>
        new() { FileId = fileId, CurrentLocator = Cfi(page), BookFraction = page / 10m, FrontierLocator = Cfi(frontierPage), FrontierFraction = frontierPage / 10m, ClientRecordedAt = DateTimeOffset.UtcNow };

    // #1122: the scheme guard, in the write itself.
    private const string PdfPage = """{"version":1,"scheme":"pdf-page","value":{"page":2}}""";
    private const string TextPosition = """{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.2}}""";

    private static ReadingState Locating(Guid fileId, string locator, decimal fraction = 0.2m) =>
        new() { FileId = fileId, CurrentLocator = locator, BookFraction = fraction, ClientRecordedAt = DateTimeOffset.UtcNow };

    [Fact]
    public async Task AdvanceAsync_PdfPageOnAnEpub_LosesFirstAndLater()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        Assert.False((await _repo.AdvanceAsync(user, book, Locating(file, PdfPage), null, default, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(file, 1), null, default, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, book, Locating(file, PdfPage, 0.3m), 1, default, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_OnAPdf_PdfPageAndTextstackWinAndEpubCfiLoses()
    {
        var user = await db.NewReaderAsync();
        var imported = new Domain.Library.Book { Id = Guid.NewGuid(), Title = "A PDF" };
        var pdf = (await _library.ImportAsync(user, imported, V2PostgresFixture.NewFile(user, imported.Id, format: "pdf"), Ct)).Book!;
        var file = pdf.CurrentFile!.Id;

        Assert.False((await _repo.AdvanceAsync(user, pdf.Id, At(file, 1), null, default, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, pdf.Id, Locating(file, PdfPage), null, default, Ct)).Accepted);
        // The transitional reader's reflow of a PDF; the chapter guard is not this test's (no keys handed in).
        Assert.True((await _repo.AdvanceAsync(user, pdf.Id, Locating(file, TextPosition, 0.3m), 1, default, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, pdf.Id, Locating(file, Cfi(4), 0.4m), 2, default, Ct)).Accepted);
    }

    // #1128: foliate addresses every non-PDF format by CFI (ADR-032); pdf-page stays PDF-only.
    [Theory]
    [InlineData("mobi")]
    [InlineData("azw3")]
    [InlineData("fb2")]
    [InlineData("cbz")]
    public async Task AdvanceAsync_OnAFoliateFormat_EpubCfiWinsAndPdfPageLoses(string format)
    {
        var user = await db.NewReaderAsync();
        var imported = new Domain.Library.Book { Id = Guid.NewGuid(), Title = "A " + format };
        var book = (await _library.ImportAsync(user, imported, V2PostgresFixture.NewFile(user, imported.Id, format: format), Ct)).Book!;
        var file = book.CurrentFile!.Id;

        Assert.False((await _repo.AdvanceAsync(user, book.Id, Locating(file, PdfPage), null, default, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book.Id, At(file, 1), null, default, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteOnAChapterTheFileLacks_LosesAndOnItsChapterWins()
    {
        var (user, book, file) = await ReaderWithChapterAsync();

        Assert.False((await _repo.AdvanceAsync(user, book, At(file, 3), null, new("gone", "gone"), Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(file, 3), null, OnChapter, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_AfterAReExtractionDroppedTheChapter_Loses()
    {
        var (user, book, file) = await ReaderWithChapterAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, OnChapter, Ct);
        await new BookChapterRepository(db.DataSource).ReplaceForFileAsync(user, book, file,
            [new() { Id = Guid.NewGuid(), ChapterKey = "renamed", ChapterNumber = 1, Title = "t", Html = "<p/>", PlainText = "", WordCount = 0 }], Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 4), 1, OnChapter, Ct);

        Assert.Equal((false, 1L), (result.Accepted, result.Current!.Revision));
    }

    // A client may echo the stored frontier back: once its chapter is gone, that must not refuse the write.
    [Fact]
    public async Task AdvanceAsync_FrontierBehindTheStoredOneOnAMissingChapter_IsIgnored()
    {
        var (user, book, file) = await ReaderWithChapterAsync();
        await _repo.AdvanceAsync(user, book, At(file, 6), null, OnChapter, Ct);

        var result = await _repo.AdvanceAsync(user, book, WithFrontier(file, 3, 5), 1, new("ch-1", "gone"), Ct);

        Assert.Equal((true, 0.6m), (result.Accepted, result.Current!.FrontierFraction));
    }

    [Fact]
    public async Task AdvanceAsync_FrontierAheadOnAMissingChapter_Loses()
    {
        var (user, book, file) = await ReaderWithChapterAsync();
        await _repo.AdvanceAsync(user, book, At(file, 6), null, OnChapter, Ct);

        Assert.False((await _repo.AdvanceAsync(user, book, WithFrontier(file, 3, 8), 1, new("ch-1", "gone"), Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_KeyOnlyAnotherUsersFileHas_Loses()
    {
        await ReaderWithChapterAsync("bobs");
        var (user, book, file) = await ReaderWithChapterAsync();

        Assert.False((await _repo.AdvanceAsync(user, book, At(file, 3), null, new("bobs", "bobs"), Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWrite_CreatesTheRowAtRevisionOne()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var result = await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        Assert.True(result.Accepted);
        var stored = (await _repo.GetAsync(user, book, Ct))!;
        Assert.Equal((1L, file, 0.3m, 0.3m), (stored.Revision, stored.FileId, stored.BookFraction, stored.FrontierFraction));
        AssertSameJson(Cfi(3), stored.CurrentLocator);
        AssertSameJson(Cfi(3), stored.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteWhenARowExists_LosesAndReturnsTheRow()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), null, default, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((1L, 0.3m), (result.Current!.Revision, result.Current.BookFraction));
    }

    [Fact]
    public async Task AdvanceAsync_MatchingRevision_WinsAndIncrementsTheRevision()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), 1, default, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((2L, 0.5m), (result.Current!.Revision, result.Current.BookFraction));
        Assert.Equal(2L, (await _repo.GetAsync(user, book, Ct))!.Revision);
    }

    [Fact]
    public async Task AdvanceAsync_StaleRevision_LosesAndReturnsTheWinnersStateIntact()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);
        await _repo.AdvanceAsync(user, book, At(file, 6), 1, default, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 4), 1, default, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((2L, 0.6m), (result.Current!.Revision, result.Current.BookFraction));
        AssertSameJson(Cfi(6), result.Current.CurrentLocator);
        Assert.Equal(0.6m, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_TwoWritersWithTheSameRevision_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        var results = await Task.WhenAll(
            _repo.AdvanceAsync(user, book, At(file, 4), 1, default, Ct),
            _repo.AdvanceAsync(user, book, At(file, 5), 1, default, Ct));

        var winner = Assert.Single(results, r => r.Accepted);
        var loser = Assert.Single(results, r => !r.Accepted);
        Assert.Equal(2L, winner.Current!.Revision);
        Assert.Equal(winner.Current.BookFraction, loser.Current!.BookFraction);
        Assert.Equal(winner.Current.BookFraction, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_MovingBack_KeepsTheFrontierLocatorAndFraction()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 8), null, default, Ct);

        var back = At(file, 2);
        back.FrontierLocator = Cfi(5); // a device that knew less: still behind the stored frontier
        back.FrontierFraction = 0.5m;
        var result = await _repo.AdvanceAsync(user, book, back, 1, default, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((0.2m, 0.8m), (result.Current!.BookFraction, result.Current.FrontierFraction));
        AssertSameJson(Cfi(8), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FrontierAheadOfStored_MovesItForward()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        var state = At(file, 2);
        state.FrontierLocator = Cfi(9);
        state.FrontierFraction = 0.9m;
        var result = await _repo.AdvanceAsync(user, book, state, 1, default, Ct);

        Assert.Equal(0.9m, result.Current!.FrontierFraction);
        AssertSameJson(Cfi(9), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteDuringAReplacement_NeverLandsOnTheSupersededFile()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        // A replacement caught mid-transaction: the file is superseded but not yet committed. Left to
        // chance the race is too rare to see, so the test holds the window open itself.
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var replacement = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE book_files SET is_current = false WHERE user_id = @user AND id = @file",
            new { user, file }, replacement, cancellationToken: Ct));

        var firstWrite = _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);
        // Commit only once the write is blocked on the file row: without FOR SHARE it never blocks,
        // commits on the superseded file, and the assertions below fail.
        await db.WaitUntilBlockedByAsync(conn, firstWrite);
        await replacement.CommitAsync(Ct);

        Assert.False((await firstWrite).Accepted);
        Assert.Null(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task AdvanceAsync_FileThatIsNotTheCurrentOne_Loses()
    {
        var (user, book, oldFile) = await ReaderWithBookAsync();
        var newFile = (await _library.ReplaceFileAsync(user, book, V2PostgresFixture.NewFile(user, book), oldFile, null, Ct)).Current!.Id;

        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 3), null, default, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(newFile, 3), null, default, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 4), 1, default, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_TwoFirstWritesAtOnce_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var results = await Task.WhenAll(Enumerable.Range(1, 4)
            .Select(page => _repo.AdvanceAsync(user, book, At(file, page), null, default, Ct)));

        Assert.Single(results, r => r.Accepted);
        Assert.All(results, r => Assert.NotNull(r.Current));
    }

    [Fact]
    public async Task AdvanceAsync_ClientTimeWithAnOffset_StoresItAsUtc()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var state = At(file, 3);
        state.ClientRecordedAt = new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.FromHours(2));
        state.CompletedAt = state.ClientRecordedAt;

        var result = await _repo.AdvanceAsync(user, book, state, null, default, Ct);

        Assert.True(result.Accepted);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 10, 0, 0, TimeSpan.Zero), result.Current!.ClientRecordedAt);
        Assert.Equal(TimeSpan.Zero, result.Current.ClientRecordedAt.Offset);
    }

    [Fact]
    public async Task AdvanceAsync_FrontierFractionWithoutLocator_TreatsItAsNoFrontier()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var state = At(file, 3);
        state.FrontierFraction = 0.5m;

        var result = await _repo.AdvanceAsync(user, book, state, null, default, Ct);

        Assert.True(result.Accepted);
        Assert.Equal(0.3m, result.Current!.FrontierFraction);
        AssertSameJson(Cfi(3), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task ResetAsync_ExistingState_ForgetsFrontierAndCompletionKeepsPositionBumpsRevisionAndRecordsIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var finished = At(file, 8);
        finished.CompletedAt = DateTimeOffset.UtcNow;
        await _repo.AdvanceAsync(user, book, finished, null, default, Ct);

        var result = await _repo.ResetAsync(user, book, 1, Ct);

        Assert.True(result.Accepted);
        var reset = result.Current!;

        Assert.Equal((2L, 2L, 0.8m, (decimal?)null, (string?)null, (DateTimeOffset?)null),
            (reset.Revision, reset.ResetRevision, reset.BookFraction, reset.FrontierFraction, reset.FrontierLocator, reset.CompletedAt));
        AssertSameJson(Cfi(8), reset.CurrentLocator);
        // The next write moves the revision on; reset_revision keeps naming the reset's.
        var next = await _repo.AdvanceAsync(user, book, At(file, 1), reset.Revision, default, Ct);
        Assert.Equal((3L, 2L, 0.1m), (next.Current!.Revision, next.Current.ResetRevision, next.Current.FrontierFraction));
    }

    [Fact]
    public async Task ResetAsync_NoState_LosesWithNoCurrent()
    {
        var (user, book, _) = await ReaderWithBookAsync();

        var result = await _repo.ResetAsync(user, book, 1, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
    }

    [Fact]
    public async Task ResetAsync_StaleRevision_LosesAndKeepsTheFrontier()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);
        await _repo.AdvanceAsync(user, book, At(file, 6), 1, default, Ct); // another device moved on

        var replayed = await _repo.ResetAsync(user, book, 1, Ct);

        Assert.False(replayed.Accepted);
        Assert.Equal((2L, 0.6m, (long?)null), (replayed.Current!.Revision, replayed.Current.FrontierFraction, replayed.Current.ResetRevision));
    }

    [Fact]
    public async Task DeleteForFileAsync_StateOfThatFile_DeletesIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        Assert.True(await _repo.DeleteForFileAsync(user, book, file, null, Ct));
        Assert.Null(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task DeleteForFileAsync_StateOfAnotherFile_KeepsIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        Assert.False(await _repo.DeleteForFileAsync(user, book, Guid.NewGuid(), null, Ct));
        Assert.NotNull(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task DeleteForFileAsync_InACallersTransactionRolledBack_KeepsTheState()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);

        await using (var tx = await db.DataSource.BeginAsync(Ct))
            Assert.True(await _repo.DeleteForFileAsync(user, book, file, tx.Transaction, Ct));

        Assert.NotNull(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_AfterACursor_ReturnsLaterStatesInUpdateOrder()
    {
        var (user, first, firstFile) = await ReaderWithBookAsync();
        var second = await db.NewBookAsync(user);
        await _repo.AdvanceAsync(user, first, At(firstFile, 3), null, default, Ct);
        var older = (await _repo.AdvanceAsync(user, second.Id, At(second.CurrentFile!.Id, 3), null, default, Ct)).Current!;
        await _repo.AdvanceAsync(user, first, At(firstFile, 4), 1, default, Ct);

        var all = await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct);
        var after = Assert.Single(await _repo.ListChangedAsync(user, older.UpdatedAt, older.BookId, 10, Ct));

        Assert.Equal([second.Id, first], all.Select(s => s.BookId));
        Assert.Equal((first, 2L), (after.BookId, after.Revision));
        Assert.Single(await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 1, Ct));
    }

    [Fact]
    public async Task AdvanceAsync_AfterReset_StaleDeviceWithOldRevision_Loses()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 8), null, default, Ct); // device A reads revision 1
        await _repo.ResetAsync(user, book, 1, Ct);                    // the reader restarts the book

        var stale = await _repo.AdvanceAsync(user, book, At(file, 9), 1, default, Ct); // device A, still on revision 1

        Assert.False(stale.Accepted);
        // Revision 1 < reset_revision 2: the loser can be told it lost to a reset, not to a move.
        Assert.Equal((2L, 2L, (decimal?)null), (stale.Current!.Revision, stale.Current.ResetRevision, stale.Current.FrontierFraction));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task GetAsync_AlicesBookAsBob_ReturnsNull()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, default, Ct);

        Assert.Null(await _repo.GetAsync(bob, book, Ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task AdvanceAsync_AlicesBookAsBob_LosesAndChangesNothing(long? expectedRevision)
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, default, Ct);

        var result = await _repo.AdvanceAsync(bob, book, At(file, 9), expectedRevision, default, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        var alices = (await _repo.GetAsync(alice, book, Ct))!;
        Assert.Equal((1L, 0.3m), (alices.Revision, alices.BookFraction));
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteOnAlicesBookAsBob_LosesAndCreatesNothing()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var result = await _repo.AdvanceAsync(bob, book, At(file, 9), null, default, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        Assert.Null(await _repo.GetAsync(alice, book, Ct));
        Assert.Null(await _repo.GetAsync(bob, book, Ct));
    }

    [Fact]
    public async Task ResetAsync_AlicesBookAsBob_LosesWithNoCurrentAndKeepsHerState()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, default, Ct);

        var result = await _repo.ResetAsync(bob, book, 1, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        var alices = (await _repo.GetAsync(alice, book, Ct))!;
        Assert.Equal((1L, 0.3m), (alices.Revision, alices.FrontierFraction));
    }

    [Fact]
    public async Task DeleteForFileAsync_AlicesStateAsBob_ReturnsFalseAndKeepsIt()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, default, Ct);

        Assert.False(await _repo.DeleteForFileAsync(bob, book, file, null, Ct));
        Assert.NotNull(await _repo.GetAsync(alice, book, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_OtherUser_SeesNoneOfAlicesStates()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, default, Ct);

        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));
    }
}
