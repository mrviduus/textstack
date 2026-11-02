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
        CurrentLocator = Page(page),
        BookFraction = page / 10m,
        ClientRecordedAt = DateTimeOffset.UtcNow,
    };

    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithBookAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        return (book.UserId, book.Id, book.CurrentFile!.Id);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWrite_CreatesTheRowAtRevisionOne()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var result = await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        Assert.True(result.Accepted);
        var stored = (await _repo.GetAsync(user, book, Ct))!;
        Assert.Equal((1L, file, 0.3m, 0.3m), (stored.Revision, stored.FileId, stored.BookFraction, stored.FrontierFraction));
        AssertSameJson(Page(3), stored.CurrentLocator);
        AssertSameJson(Page(3), stored.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteWhenARowExists_LosesAndReturnsTheRow()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), null, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((1L, 0.3m), (result.Current!.Revision, result.Current.BookFraction));
    }

    [Fact]
    public async Task AdvanceAsync_MatchingRevision_WinsAndIncrementsTheRevision()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((2L, 0.5m), (result.Current!.Revision, result.Current.BookFraction));
        Assert.Equal(2L, (await _repo.GetAsync(user, book, Ct))!.Revision);
    }

    [Fact]
    public async Task AdvanceAsync_StaleRevision_LosesAndReturnsTheWinnersStateIntact()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);
        await _repo.AdvanceAsync(user, book, At(file, 6), 1, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 4), 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((2L, 0.6m), (result.Current!.Revision, result.Current.BookFraction));
        AssertSameJson(Page(6), result.Current.CurrentLocator);
        Assert.Equal(0.6m, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_TwoWritersWithTheSameRevision_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var results = await Task.WhenAll(
            _repo.AdvanceAsync(user, book, At(file, 4), 1, Ct),
            _repo.AdvanceAsync(user, book, At(file, 5), 1, Ct));

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
        await _repo.AdvanceAsync(user, book, At(file, 8), null, Ct);

        var back = At(file, 2);
        back.FrontierLocator = Page(5); // a device that knew less: still behind the stored frontier
        back.FrontierFraction = 0.5m;
        var result = await _repo.AdvanceAsync(user, book, back, 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((0.2m, 0.8m), (result.Current!.BookFraction, result.Current.FrontierFraction));
        AssertSameJson(Page(8), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FrontierAheadOfStored_MovesItForward()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var state = At(file, 2);
        state.FrontierLocator = Page(9);
        state.FrontierFraction = 0.9m;
        var result = await _repo.AdvanceAsync(user, book, state, 1, Ct);

        Assert.Equal(0.9m, result.Current!.FrontierFraction);
        AssertSameJson(Page(9), result.Current.FrontierLocator);
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

        var firstWrite = _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);
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

        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 3), null, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(newFile, 3), null, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 4), 1, Ct)).Accepted);
    }

    [Fact]
    public async Task AdvanceAsync_TwoFirstWritesAtOnce_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var results = await Task.WhenAll(Enumerable.Range(1, 4)
            .Select(page => _repo.AdvanceAsync(user, book, At(file, page), null, Ct)));

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

        var result = await _repo.AdvanceAsync(user, book, state, null, Ct);

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

        var result = await _repo.AdvanceAsync(user, book, state, null, Ct);

        Assert.True(result.Accepted);
        Assert.Equal(0.3m, result.Current!.FrontierFraction);
        AssertSameJson(Page(3), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task ResetAsync_ExistingState_ForgetsFrontierAndCompletionKeepsPositionBumpsRevisionAndRecordsIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        var finished = At(file, 8);
        finished.CompletedAt = DateTimeOffset.UtcNow;
        await _repo.AdvanceAsync(user, book, finished, null, Ct);

        var result = await _repo.ResetAsync(user, book, 1, Ct);

        Assert.True(result.Accepted);
        var reset = result.Current!;

        Assert.Equal((2L, 2L, 0.8m, (decimal?)null, (string?)null, (DateTimeOffset?)null),
            (reset.Revision, reset.ResetRevision, reset.BookFraction, reset.FrontierFraction, reset.FrontierLocator, reset.CompletedAt));
        AssertSameJson(Page(8), reset.CurrentLocator);
        // The next write moves the revision on; reset_revision keeps naming the reset's.
        var next = await _repo.AdvanceAsync(user, book, At(file, 1), reset.Revision, Ct);
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
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);
        await _repo.AdvanceAsync(user, book, At(file, 6), 1, Ct); // another device moved on

        var replayed = await _repo.ResetAsync(user, book, 1, Ct);

        Assert.False(replayed.Accepted);
        Assert.Equal((2L, 0.6m, (long?)null), (replayed.Current!.Revision, replayed.Current.FrontierFraction, replayed.Current.ResetRevision));
    }

    [Fact]
    public async Task DeleteForFileAsync_StateOfThatFile_DeletesIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        Assert.True(await _repo.DeleteForFileAsync(user, book, file, null, Ct));
        Assert.Null(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task DeleteForFileAsync_StateOfAnotherFile_KeepsIt()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        Assert.False(await _repo.DeleteForFileAsync(user, book, Guid.NewGuid(), null, Ct));
        Assert.NotNull(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task DeleteForFileAsync_InACallersTransactionRolledBack_KeepsTheState()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        await using (var tx = await db.DataSource.BeginAsync(Ct))
            Assert.True(await _repo.DeleteForFileAsync(user, book, file, tx.Transaction, Ct));

        Assert.NotNull(await _repo.GetAsync(user, book, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_AfterACursor_ReturnsLaterStatesInUpdateOrder()
    {
        var (user, first, firstFile) = await ReaderWithBookAsync();
        var second = await db.NewBookAsync(user);
        await _repo.AdvanceAsync(user, first, At(firstFile, 3), null, Ct);
        var older = (await _repo.AdvanceAsync(user, second.Id, At(second.CurrentFile!.Id, 3), null, Ct)).Current!;
        await _repo.AdvanceAsync(user, first, At(firstFile, 4), 1, Ct);

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
        await _repo.AdvanceAsync(user, book, At(file, 8), null, Ct); // device A reads revision 1
        await _repo.ResetAsync(user, book, 1, Ct);                    // the reader restarts the book

        var stale = await _repo.AdvanceAsync(user, book, At(file, 9), 1, Ct); // device A, still on revision 1

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
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        Assert.Null(await _repo.GetAsync(bob, book, Ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task AdvanceAsync_AlicesBookAsBob_LosesAndChangesNothing(long? expectedRevision)
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(bob, book, At(file, 9), expectedRevision, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        var alices = (await _repo.GetAsync(alice, book, Ct))!;
        Assert.Equal((1L, 0.3m), (alices.Revision, alices.BookFraction));
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteOnAlicesBookAsBob_LosesAndCreatesNothing()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var result = await _repo.AdvanceAsync(bob, book, At(file, 9), null, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        Assert.Null(await _repo.GetAsync(alice, book, Ct));
        Assert.Null(await _repo.GetAsync(bob, book, Ct));
    }

    [Fact]
    public async Task ResetAsync_AlicesBookAsBob_LosesWithNoCurrentAndKeepsHerState()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

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
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        Assert.False(await _repo.DeleteForFileAsync(bob, book, file, null, Ct));
        Assert.NotNull(await _repo.GetAsync(alice, book, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_OtherUser_SeesNoneOfAlicesStates()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));
    }
}
