using Application.Transitional;
using Dapper;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.TestJson;

namespace TextStack.Persistence.Tests.Reading;

public class ReadingStateRepositoryTests(PostgresFixture db)
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

    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithFileAsync(string format)
    {
        var user = await db.NewReaderAsync();
        var imported = new Domain.Library.Book { Id = Guid.NewGuid(), Title = "A " + format };
        var book = (await _library.ImportAsync(user, imported, PostgresFixture.NewFile(user, imported.Id, format: format), Ct)).Book!;
        return (user, book.Id, book.CurrentFile!.Id);
    }

    /// <summary>A reader's book whose file's synced TOC (ADR-033) has the one entry <paramref name="key"/>.</summary>
    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithChapterAsync(string key = "ch-1")
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await SyncTocAsync(user, book, file, key);
        return (user, book, file);
    }

    private Task SyncTocAsync(Guid user, Guid book, Guid file, string key) =>
        _library.SetTocAsync(user, book, file, $$$"""[{"key":"{{{key}}}","title":"{{{key}}}","depth":0,"fraction":0}]""", Ct);

    private static readonly TransitionalChapterKeys OnChapter = new("ch-1", "ch-1");

    private static ReadingState WithFrontier(Guid fileId, int page, int frontierPage) =>
        new() { FileId = fileId, CurrentLocator = Cfi(page), BookFraction = page / 10m, FrontierLocator = Cfi(frontierPage), FrontierFraction = frontierPage / 10m, ClientRecordedAt = DateTimeOffset.UtcNow };

    private static ReadingState Locating(Guid fileId, string locator, decimal fraction = 0.2m) =>
        new() { FileId = fileId, CurrentLocator = locator, BookFraction = fraction, ClientRecordedAt = DateTimeOffset.UtcNow };

    // A reader on the phone and on the web: the write naming the stored revision wins, the stale one gets the stored state.
    [Fact]
    public async Task AdvanceAsync_ReaderOnThePhoneThenTheWeb_NewerRevisionWinsAndStaleGetsTheStoredState()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var phone = At(file, 3);
        phone.ClientRecordedAt = new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.FromHours(2));
        phone.CompletedAt = phone.ClientRecordedAt;
        phone.FrontierFraction = 0.5m; // a fraction without a locator is no frontier

        var first = await _repo.AdvanceAsync(user, book, phone, null, default, Ct);

        Assert.True(first.Accepted);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 10, 0, 0, TimeSpan.Zero), first.Current!.ClientRecordedAt);
        Assert.Equal(TimeSpan.Zero, first.Current.ClientRecordedAt.Offset);
        var stored = (await _repo.GetAsync(user, book, Ct))!;
        Assert.Equal((1L, file, 0.3m, 0.3m), (stored.Revision, stored.FileId, stored.BookFraction, stored.FrontierFraction));
        AssertSameJson(Cfi(3), stored.CurrentLocator);
        AssertSameJson(Cfi(3), stored.FrontierLocator);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 10, 0, 0, TimeSpan.Zero), stored.CompletedAt);

        // The web, not knowing a row exists, writes as if first: it loses and gets the row.
        var blind = await _repo.AdvanceAsync(user, book, At(file, 5), null, default, Ct);
        Assert.False(blind.Accepted);
        Assert.Equal((1L, 0.3m), (blind.Current!.Revision, blind.Current.BookFraction));

        var web = await _repo.AdvanceAsync(user, book, At(file, 6), 1, default, Ct);
        Assert.True(web.Accepted);
        Assert.Equal((2L, 0.6m), (web.Current!.Revision, web.Current.BookFraction));
        Assert.Equal(2L, (await _repo.GetAsync(user, book, Ct))!.Revision);

        // The phone, still on revision 1.
        var stale = await _repo.AdvanceAsync(user, book, At(file, 4), 1, default, Ct);
        Assert.False(stale.Accepted);
        Assert.Equal((2L, 0.6m), (stale.Current!.Revision, stale.Current.BookFraction));
        AssertSameJson(Cfi(6), stale.Current.CurrentLocator);
        Assert.Equal(0.6m, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_ReaderFlipsBackThenAhead_FrontierOnlyMovesForward()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 8), null, default, Ct);

        var back = WithFrontier(file, 2, 5); // a device that knew less: still behind the stored frontier
        var result = await _repo.AdvanceAsync(user, book, back, 1, default, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((0.2m, 0.8m), (result.Current!.BookFraction, result.Current.FrontierFraction));
        AssertSameJson(Cfi(8), result.Current.FrontierLocator);

        var ahead = await _repo.AdvanceAsync(user, book, WithFrontier(file, 2, 9), 2, default, Ct);

        Assert.Equal(0.9m, ahead.Current!.FrontierFraction);
        AssertSameJson(Cfi(9), ahead.Current.FrontierLocator);
    }

    [Fact]
    public async Task ResetAsync_ReaderRestartsAFinishedBook_ForgetsFrontierAndStaleDevicesLose()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var none = await _repo.ResetAsync(user, book, 1, Ct);
        Assert.Equal((false, (ReadingState?)null), (none.Accepted, none.Current));

        await _repo.AdvanceAsync(user, book, At(file, 3), null, default, Ct);
        var finished = At(file, 8);
        finished.CompletedAt = DateTimeOffset.UtcNow;
        await _repo.AdvanceAsync(user, book, finished, 1, default, Ct); // another device moved on
        Assert.NotNull((await _repo.GetAsync(user, book, Ct))!.CompletedAt);

        var replayed = await _repo.ResetAsync(user, book, 1, Ct);
        Assert.False(replayed.Accepted);
        Assert.Equal((2L, 0.8m, (long?)null), (replayed.Current!.Revision, replayed.Current.FrontierFraction, replayed.Current.ResetRevision));

        var result = await _repo.ResetAsync(user, book, 2, Ct);
        Assert.True(result.Accepted);
        var reset = result.Current!;
        Assert.Equal((3L, 3L, 0.8m, (decimal?)null, (string?)null, (DateTimeOffset?)null),
            (reset.Revision, reset.ResetRevision, reset.BookFraction, reset.FrontierFraction, reset.FrontierLocator, reset.CompletedAt));
        AssertSameJson(Cfi(8), reset.CurrentLocator);

        // A device still on revision 2 < reset_revision 3: it can be told it lost to a reset, not to a move.
        var stale = await _repo.AdvanceAsync(user, book, At(file, 9), 2, default, Ct);
        Assert.False(stale.Accepted);
        Assert.Equal((3L, 3L, (decimal?)null), (stale.Current!.Revision, stale.Current.ResetRevision, stale.Current.FrontierFraction));

        // The next write moves the revision on; reset_revision keeps naming the reset's.
        var next = await _repo.AdvanceAsync(user, book, At(file, 1), reset.Revision, default, Ct);
        Assert.Equal((4L, 3L, 0.1m), (next.Current!.Revision, next.Current.ResetRevision, next.Current.FrontierFraction));
    }

    // #1122/#1128/#1188/#1196: the scheme guard, in the write itself. Foliate addresses every non-PDF format
    // by CFI (ADR-032); pdf-page stays PDF-only; page-name fits a cbz and a (pre-paginated) epub.
    private const string PdfPage = """{"version":1,"scheme":"pdf-page","value":{"page":2}}""";
    private const string PageName = """{"version":1,"scheme":"page-name","value":{"page":"p02.png","index":1}}""";
    private const string TextPosition = """{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.2}}""";

    [Theory]
    [InlineData("epub", true, false, true)]
    [InlineData("pdf", false, true, false)]
    [InlineData("mobi", true, false, false)]
    [InlineData("azw3", true, false, false)]
    [InlineData("fb2", true, false, false)]
    [InlineData("cbz", true, false, true)]
    public async Task AdvanceAsync_ReaderOpensEachFormat_OnlyItsLocatorSchemesFit(string format, bool cfi, bool pdfPage, bool pageName)
    {
        var (user, book, file) = await ReaderWithFileAsync(format);
        (string Locator, decimal Fraction, bool Fits)[] schemes = [(PageName, 0.1m, pageName), (Cfi(1), 0.2m, cfi), (PdfPage, 0.2m, pdfPage)];

        // The position's own guard and the frontier's, on the first write (insert) and on a later one (update).
        async Task MisfitsLoseAsync(long? expectedRevision)
        {
            foreach (var misfit in schemes.Where(s => !s.Fits))
                Assert.False((await _repo.AdvanceAsync(user, book, Locating(file, misfit.Locator, 0.3m), expectedRevision, default, Ct)).Accepted);
            if (!cfi || pageName)
                return;
            // A fitting frontier further on does not carry a misfit position.
            var behind = Locating(file, PageName, 0.2m);
            behind.FrontierLocator = Cfi(9);
            behind.FrontierFraction = 0.9m;
            Assert.False((await _repo.AdvanceAsync(user, book, behind, expectedRevision, default, Ct)).Accepted);

            var misfitFrontier = At(file, 1);
            misfitFrontier.FrontierLocator = PageName;
            misfitFrontier.FrontierFraction = 0.9m;
            Assert.False((await _repo.AdvanceAsync(user, book, misfitFrontier, expectedRevision, default, Ct)).Accepted);
        }

        await MisfitsLoseAsync(null);
        Assert.Null(await _repo.GetAsync(user, book, Ct));

        long? revision = null;
        foreach (var (locator, fraction, _) in schemes.Where(s => s.Fits))
        {
            var write = Locating(file, locator, fraction);
            write.FrontierLocator = locator;
            write.FrontierFraction = fraction;
            var result = await _repo.AdvanceAsync(user, book, write, revision, default, Ct);
            Assert.True(result.Accepted);
            revision = result.Current!.Revision;
            var stored = (await _repo.GetAsync(user, book, Ct))!;
            AssertSameJson(locator, stored.CurrentLocator);
            AssertSameJson(locator, stored.FrontierLocator);
        }

        await MisfitsLoseAsync(revision);

        if (format == "pdf") // the transitional reader's reflow of a PDF; the chapter guard is not this test's (no keys)
        {
            var reflow = await _repo.AdvanceAsync(user, book, Locating(file, TextPosition, 0.3m), revision, default, Ct);
            Assert.True(reflow.Accepted);
            revision = reflow.Current!.Revision;
        }
    }

    // ADR-033: a textstack-* write (the assistant's) names a key of the file's synced TOC, checked in the statement itself.
    [Fact]
    public async Task AdvanceAsync_AssistantOnAChapter_WritesOnlyWhileTheTocHasIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        // No TOC synced yet: no key is known. A free-form one from before P3 is no match either, never an error.
        Assert.False((await _repo.AdvanceAsync(user, book, At(file, 6), null, OnChapter, Ct)).Accepted);
        await _library.SetTocAsync(user, book, file, """{"title":"ch-1","key":"ch-1"}""", Ct);
        Assert.False((await _repo.AdvanceAsync(user, book, At(file, 6), null, OnChapter, Ct)).Accepted);
        await SyncTocAsync(user, book, file, "ch-1");

        Assert.False((await _repo.AdvanceAsync(user, book, At(file, 6), null, new("gone", "gone"), Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(file, 6), null, OnChapter, Ct)).Accepted);

        // A client may echo the stored frontier back: once its chapter is gone, that must not refuse the write.
        var echo = await _repo.AdvanceAsync(user, book, WithFrontier(file, 3, 5), 1, new("ch-1", "gone"), Ct);
        Assert.Equal((true, 0.6m), (echo.Accepted, echo.Current!.FrontierFraction));
        Assert.False((await _repo.AdvanceAsync(user, book, WithFrontier(file, 3, 8), 2, new("ch-1", "gone"), Ct)).Accepted);

        // The reader rewrites the TOC without the key.
        await SyncTocAsync(user, book, file, "renamed");
        var dropped = await _repo.AdvanceAsync(user, book, At(file, 4), 2, OnChapter, Ct);
        Assert.Equal((false, 2L), (dropped.Accepted, dropped.Current!.Revision));
        // The stored position echoed back unchanged (mark-read on an old server key) still lands, also after a reset
        // (mark unread) cleared the frontier the echo now offers.
        Assert.True((await _repo.AdvanceAsync(user, book, At(file, 3), 2, OnChapter, Ct)).Accepted);
        Assert.True((await _repo.ResetAsync(user, book, 3, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(file, 3), 4, OnChapter, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_ReaderReplacesTheBooksFile_OldFileLosesAndOnlyTheRemovedFilesStateIsDeleted()
    {
        var (user, book, oldFile) = await ReaderWithBookAsync();
        var newFile = (await _library.ReplaceFileAsync(user, book, PostgresFixture.NewFile(user, book), oldFile, null, Ct)).Current!.Id;

        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 3), null, default, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(newFile, 3), null, default, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 4), 1, default, Ct)).Accepted);

        Assert.False(await _repo.DeleteForFileAsync(user, book, oldFile, null, Ct));
        Assert.NotNull(await _repo.GetAsync(user, book, Ct));

        await using (var tx = await db.DataSource.BeginAsync(Ct))
            Assert.True(await _repo.DeleteForFileAsync(user, book, newFile, tx.Transaction, Ct)); // rolled back
        Assert.NotNull(await _repo.GetAsync(user, book, Ct));

        Assert.True(await _repo.DeleteForFileAsync(user, book, newFile, null, Ct));
        Assert.Null(await _repo.GetAsync(user, book, Ct));
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

    // Owner isolation: bob, holding alice's ids, never reads, changes or deletes her rows; nor does alice write
    // on a chapter key only a third reader's file has.
    [Fact]
    public async Task AdvanceAsync_BobHoldingAlicesIds_NeverReadsChangesOrDeletesHerState()
    {
        await ReaderWithChapterAsync("bobs");
        var (alice, book, file) = await ReaderWithChapterAsync();
        var bob = await db.NewReaderAsync();
        var unread = await db.NewBookAsync(alice);

        Assert.False((await _repo.AdvanceAsync(alice, book, At(file, 3), null, new("bobs", "bobs"), Ct)).Accepted);
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, OnChapter, Ct);

        Assert.Null(await _repo.GetAsync(bob, book, Ct));
        foreach (var expectedRevision in new long?[] { null, 1 })
        {
            var write = await _repo.AdvanceAsync(bob, book, At(file, 9), expectedRevision, default, Ct);
            Assert.Equal((false, (ReadingState?)null), (write.Accepted, write.Current));
        }
        var firstWrite = await _repo.AdvanceAsync(bob, unread.Id, At(unread.CurrentFile!.Id, 9), null, default, Ct);
        Assert.Equal((false, (ReadingState?)null), (firstWrite.Accepted, firstWrite.Current));
        Assert.Null(await _repo.GetAsync(alice, unread.Id, Ct));
        Assert.Null(await _repo.GetAsync(bob, unread.Id, Ct));

        var reset = await _repo.ResetAsync(bob, book, 1, Ct);
        Assert.Equal((false, (ReadingState?)null), (reset.Accepted, reset.Current));
        Assert.False(await _repo.DeleteForFileAsync(bob, book, file, null, Ct));
        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));

        var alices = (await _repo.GetAsync(alice, book, Ct))!;
        Assert.Equal((1L, 0.3m, 0.3m), (alices.Revision, alices.BookFraction, alices.FrontierFraction));
    }

    // Concurrency: each its own test.

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
    public async Task AdvanceAsync_TwoFirstWritesAtOnce_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var results = await Task.WhenAll(Enumerable.Range(1, 4)
            .Select(page => _repo.AdvanceAsync(user, book, At(file, page), null, default, Ct)));

        Assert.Single(results, r => r.Accepted);
        Assert.All(results, r => Assert.NotNull(r.Current));
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
}
