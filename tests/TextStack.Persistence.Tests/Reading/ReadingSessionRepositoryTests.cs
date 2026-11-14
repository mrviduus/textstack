using Application.Common;
using Application.ReadingTracking;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Reading;

public class ReadingSessionRepositoryTests(V2PostgresFixture db)
{
    private readonly ReadingSessionRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static ReadingSession Session(Guid? bookId, Guid? clientSessionId = null, int wordsRead = 100) => new()
    {
        ClientSessionId = clientSessionId ?? Guid.NewGuid(),
        BookId = bookId,
        StartedAt = new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.FromHours(2)),
        EndedAt = new DateTimeOffset(2026, 10, 30, 12, 5, 0, TimeSpan.FromHours(2)),
        DurationSeconds = 300,
        WordsRead = wordsRead,
        StartPercent = 0.1m,
        EndPercent = 0.2m,
    };

    [Fact]
    public async Task SaveAsync_NewSession_StoresItUnderTheUser()
    {
        var book = await db.NewReaderWithBookAsync();
        var session = Session(book.Id);

        var result = await _repo.SaveAsync(book.UserId, session, Ct);

        Assert.Equal(WriteOutcome.Created, result.Outcome);
        Assert.Equal((book.UserId, session.ClientSessionId, book.Id, 100, 0.2m), (result.Row!.UserId, result.Row.ClientSessionId, result.Row.BookId, result.Row.WordsRead, result.Row.EndPercent));
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 10, 0, 0, TimeSpan.Zero), result.Row.StartedAt);
        Assert.Equal(1L, await db.CountAsync("reading_sessions", book.UserId));
    }

    [Fact]
    public async Task SaveAsync_WithoutABook_StoresIt()
    {
        var user = await db.NewReaderAsync();

        Assert.Equal(WriteOutcome.Created, (await _repo.SaveAsync(user, Session(null), Ct)).Outcome);
    }

    [Fact]
    public async Task SaveAsync_SameClientSessionIdAgain_ReplaysTheFirstWrite()
    {
        var book = await db.NewReaderWithBookAsync();
        var clientSessionId = Guid.NewGuid();
        var first = await _repo.SaveAsync(book.UserId, Session(book.Id, clientSessionId, wordsRead: 100), Ct);

        var replay = await _repo.SaveAsync(book.UserId, Session(book.Id, clientSessionId, wordsRead: 999), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Row!.Id, 100), (replay.Outcome, replay.Row!.Id, replay.Row.WordsRead));
        Assert.Equal(1L, await db.CountAsync("reading_sessions", book.UserId));
    }

    // Owner isolation: bob, holding alice's ids, never reads or changes her rows.

    [Fact]
    public async Task SaveAsync_AlicesClientSessionIdAsBob_CreatesBobsOwnAndLeavesHersIntact()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var clientSessionId = Guid.NewGuid();
        var hers = await _repo.SaveAsync(alices.UserId, Session(alices.Id, clientSessionId), Ct);

        var his = await _repo.SaveAsync(bob, Session(null, clientSessionId, wordsRead: 7), Ct);

        Assert.Equal((WriteOutcome.Created, bob), (his.Outcome, his.Row!.UserId));
        Assert.NotEqual(hers.Row!.Id, his.Row.Id);
        Assert.Equal(1L, await db.CountAsync("reading_sessions", alices.UserId));
    }

    [Fact]
    public async Task SaveAsync_AlicesBookAsBob_IsRefusedByTheForeignKey()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        // A broken invariant: the use case checks the book first and answers book_not_found.
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(bob, Session(alices.Id), Ct));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        Assert.Equal(0L, await db.CountAsync("reading_sessions", bob));
    }

    [Fact]
    public async Task PaceTotalsAsync_OwnSessionsWithWordsAndTime_CountedNotEtlCarriedOnesNorAnotherUsers()
    {
        var mine = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        await _repo.SaveAsync(mine.UserId, Session(mine.Id, wordsRead: 100), Ct);
        await _repo.SaveAsync(mine.UserId, Session(mine.Id, wordsRead: 200), Ct);
        await _repo.SaveAsync(mine.UserId, Session(mine.Id, wordsRead: 0), Ct);
        var noTime = Session(mine.Id, wordsRead: 50);
        noTime.DurationSeconds = 0;
        await _repo.SaveAsync(mine.UserId, noTime, Ct);
        await _repo.SaveAsync(bobs.UserId, Session(bobs.Id, wordsRead: 500), Ct);
        // As EtlV2Sessions carries a legacy session: its id is both ids, and legacy's pace already counts it.
        var carried = Guid.NewGuid();
        await db.ExecAsync("""
            INSERT INTO reading_sessions (id, user_id, client_session_id, book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES (@carried, @userId, @carried, NULL, now(), now(), 300, 900, 0, 0, now())
            """, new { carried, userId = mine.UserId });

        Assert.Equal(new PaceTotals(2, 300, 600), await _repo.PaceTotalsAsync(mine.UserId, excludeEtlCarried: true, Ct));
        Assert.Equal(new PaceTotals(3, 1200, 900), await _repo.PaceTotalsAsync(mine.UserId, excludeEtlCarried: false, Ct));
    }
}
