using Application.Common.Interfaces;
using Application.ReadingTracking;
using Contracts.ReadingTracking;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Moq;

namespace TextStack.UnitTests;

// R5 slice-4: ReadingSessionService.SubmitAsync over a Moq IAppDbContext whose sets are backed by
// plain List<T>. Unlike the read-only ReadingStatsServiceTests harness, this FakeSet is MUTABLE —
// Add() appends to the backing list via Callback — so the achievement checker (run on the same Moq db,
// NOT mocked) sees the just-saved session. That is what lets the "ordering" test prove the save-before-
// check contract: `first_session` only unlocks if the session is already in the backing list when the
// checker counts sessions. The mutation, dedup asymmetry (pre-check → Guid.Empty, race → session.Id),
// best-effort swallow, and the 23505 race fallback are all exercised with hand-computed values.
public class ReadingSessionServiceTests
{
    private sealed class Harness
    {
        public List<ReadingSession> Sessions { get; } = [];
        public List<UserAchievement> Achievements { get; } = [];
        public List<ReadingGoal> Goals { get; } = [];
        public List<VocabularyReview> Reviews { get; } = [];
        public List<UserBook> Books { get; } = [];
        public List<Edition> Editions { get; } = [];
        public int SaveCalls { get; private set; }
        public Mock<IAppDbContext> Db { get; } = new();
        public Mock<ILogger<ReadingSessionService>> Logger { get; } = new();
        public ReadingSessionService Service { get; }

        /// <summary>When set, SaveChangesAsync throws this on the Nth (1-based) call.</summary>
        public Exception? ThrowOnSaveCall { get; set; }
        public int ThrowOnSaveCallNumber { get; set; } = 1;

        public Harness()
        {
            Db.Setup(x => x.ReadingSessions).Returns(() => FakeSet(Sessions).Object);
            Db.Setup(x => x.UserAchievements).Returns(() => FakeSet(Achievements).Object);
            Db.Setup(x => x.ReadingGoals).Returns(() => FakeSet(Goals).Object);
            Db.Setup(x => x.VocabularyReviews).Returns(() => FakeSet(Reviews).Object);
            Db.Setup(x => x.UserBooks).Returns(() => FakeSet(Books).Object);
            Db.Setup(x => x.Editions).Returns(() => FakeSet(Editions).Object);
            Db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()))
                .ReturnsAsync(() =>
                {
                    SaveCalls++;
                    if (ThrowOnSaveCall is not null && SaveCalls == ThrowOnSaveCallNumber)
                        throw ThrowOnSaveCall;
                    return 1;
                });
            Service = new ReadingSessionService(Db.Object, Logger.Object);
        }

        // Seed a live edition / owned user-book so the SubmitAsync existence pre-check passes.
        public Guid SeedEdition()
        {
            var id = Guid.NewGuid();
            Editions.Add(new Edition
            {
                Id = id,
                WorkId = Guid.NewGuid(),
                SiteId = Guid.NewGuid(),
                Language = "en",
                Slug = "ed-" + id.ToString("N")[..8],
                Title = "Test Edition",
            });
            return id;
        }

        public Guid SeedUserBook(Guid userId)
        {
            var id = Guid.NewGuid();
            Books.Add(new UserBook
            {
                Id = id,
                UserId = userId,
                Title = "Test Book",
                Slug = "ub-" + id.ToString("N")[..8],
                Language = "en",
            });
            return id;
        }
    }

    // Mutable DbSet<T> mock backed by `data`: queryable (sync + async) + Add() appends to the list.
    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        set.Setup(m => m.Add(It.IsAny<T>())).Callback<T>(e => data.Add(e));
        return set;
    }

    private static SubmitSessionRequest EditionReq(
        Guid editionId, DateTimeOffset started, DateTimeOffset ended, int dur = 300, int words = 100,
        double endPct = 0.5) =>
        new(EditionId: editionId, UserBookId: null, StartedAt: started, EndedAt: ended,
            DurationSeconds: dur, WordsRead: words, StartPercent: 0, EndPercent: endPct);

    private static SubmitSessionRequest UserBookReq(
        Guid userBookId, DateTimeOffset started, DateTimeOffset ended, int dur = 300, int words = 100,
        double endPct = 0.5) =>
        new(EditionId: null, UserBookId: userBookId, StartedAt: started, EndedAt: ended,
            DurationSeconds: dur, WordsRead: words, StartPercent: 0, EndPercent: endPct);

    private static ReadingSession SeedSession(Guid userId, Guid? editionId, Guid? userBookId, DateTimeOffset started) => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        EditionId = editionId,
        UserBookId = userBookId,
        StartedAt = started,
        EndedAt = started.AddMinutes(5),
        DurationSeconds = 300,
        WordsRead = 100,
        StartPercent = 0,
        EndPercent = 0.5,
        CreatedAt = started,
    };

    // ── Ordering (main): save-before-check ──────────────────────────────────────────────────────
    // Empty db → submit → the achievement checker runs on the SAME Moq db and must see the just-added
    // session (sessionCount == 1) to unlock "first_session". Values are chosen so ONLY first_session
    // unlocks: endPct 0.5 (not finished), 12:00 hour (not early_bird/night_owl), 20 wpm (< 400),
    // 300s (< 1h, streak=1 < 3, < 2h marathon).
    [Fact]
    public async Task SubmitAsync_EmptyDb_UnlocksFirstSession_ProvingSaveBeforeCheck()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var req = EditionReq(h.SeedEdition(), started, started.AddMinutes(5));

        var r = await h.Service.SubmitAsync(userId, siteId, req, CancellationToken.None);

        Assert.NotNull(r);
        Assert.NotEqual(Guid.Empty, r.SessionId);
        Assert.Contains("first_session", r.NewAchievements);   // only unlocks if session already persisted
        Assert.Equal(new[] { "first_session" }, r.NewAchievements.ToArray());
        Assert.Single(h.Sessions);
        Assert.Equal(r.SessionId, h.Sessions[0].Id);
        h.Db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.AtLeastOnce);
    }

    // ── Dedup: user-book pre-check returns Guid.Empty, inserts nothing, never saves ──────────────
    [Fact]
    public async Task SubmitAsync_DuplicateUserBookSession_ReturnsGuidEmpty_NoInsertNoSave()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var userBookId = h.SeedUserBook(userId);
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        h.Sessions.Add(SeedSession(userId, editionId: null, userBookId: userBookId, started: started));

        var r = await h.Service.SubmitAsync(userId, siteId, UserBookReq(userBookId, started, started.AddMinutes(5)), CancellationToken.None);

        Assert.NotNull(r);
        Assert.Equal(Guid.Empty, r.SessionId);                 // pre-check → Guid.Empty (asymmetry vs race)
        Assert.Empty(r.NewAchievements);
        Assert.Single(h.Sessions);                             // no new row
        h.Db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── Edition sessions dedup too: a client retry of the same session must not double-count ────
    [Fact]
    public async Task SubmitAsync_TwoIdenticalEditionSessions_SecondIsIdempotentAck()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var editionId = h.SeedEdition();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var req = EditionReq(editionId, started, started.AddMinutes(5));

        var r1 = await h.Service.SubmitAsync(userId, siteId, req, CancellationToken.None);
        var r2 = await h.Service.SubmitAsync(userId, siteId, req, CancellationToken.None);

        Assert.NotNull(r1);
        Assert.NotNull(r2);
        Assert.NotEqual(Guid.Empty, r1.SessionId);
        Assert.Equal(Guid.Empty, r2.SessionId);
        Assert.Single(h.Sessions);
    }

    [Fact]
    public async Task SubmitAsync_EditionSessionsWithDifferentStart_BothInserted()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var editionId = h.SeedEdition();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);

        await h.Service.SubmitAsync(userId, siteId, EditionReq(editionId, started, started.AddMinutes(5)), CancellationToken.None);
        await h.Service.SubmitAsync(userId, siteId, EditionReq(editionId, started.AddMinutes(10), started.AddMinutes(15)), CancellationToken.None);

        Assert.Equal(2, h.Sessions.Count);
    }

    // ── Best-effort: achievement path throws → session still saved, no rethrow, warning logged ───
    [Fact]
    public async Task SubmitAsync_AchievementCheckThrows_SwallowsAndReturnsSavedSession()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var editionId = h.SeedEdition();
        // Make the achievement phase blow up (checker's first read is _db.UserAchievements).
        h.Db.Setup(x => x.UserAchievements).Throws(new InvalidOperationException("boom"));

        var r = await h.Service.SubmitAsync(userId, siteId, EditionReq(editionId, started, started.AddMinutes(5)), CancellationToken.None);

        Assert.NotNull(r);
        Assert.Equal(h.Sessions[0].Id, r.SessionId);           // session was saved (step 7 ran before the throw)
        Assert.Empty(r.NewAchievements);                       // stays [] on swallow
        Assert.Single(h.Sessions);
        h.Logger.Verify(
            x => x.Log(
                LogLevel.Warning,
                It.IsAny<EventId>(),
                It.IsAny<It.IsAnyType>(),
                It.IsAny<Exception>(),
                (Func<It.IsAnyType, Exception?, string>)It.IsAny<object>()),
            Times.Once);
    }

    // ── Race 23505: SaveChanges throws unique-violation → ack idempotently with session.Id ───────
    [Fact]
    public async Task SubmitAsync_SaveThrows23505_ReturnsSessionId_NoRethrow()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var inner = new Npgsql.PostgresException("duplicate key", "ERROR", "ERROR", "23505");
        h.ThrowOnSaveCall = new DbUpdateException("unique violation", inner);

        var r = await h.Service.SubmitAsync(userId, siteId, EditionReq(h.SeedEdition(), started, started.AddMinutes(5)), CancellationToken.None);

        Assert.NotNull(r);
        Assert.NotEqual(Guid.Empty, r.SessionId);              // race → session.Id (asymmetry vs pre-check Guid.Empty)
        Assert.Equal(h.Sessions[0].Id, r.SessionId);
        Assert.Empty(r.NewAchievements);
    }

    // ── Non-23505 save failures are NOT swallowed — they propagate ───────────────────────────────
    [Fact]
    public async Task SubmitAsync_SaveThrowsOtherException_Propagates()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        h.ThrowOnSaveCall = new InvalidOperationException("db down");

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Service.SubmitAsync(userId, siteId, EditionReq(h.SeedEdition(), started, started.AddMinutes(5)), CancellationToken.None));
    }

    // ── Existence guard: referenced user_book gone (re-upload) → null (caller maps to 404) ────────
    [Fact]
    public async Task SubmitAsync_UserBookMissing_ReturnsNull_NoInsert()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        // No SeedUserBook → the referenced book does not exist (deleted after re-upload).
        var req = UserBookReq(Guid.NewGuid(), started, started.AddMinutes(5));

        var r = await h.Service.SubmitAsync(userId, siteId, req, CancellationToken.None);

        Assert.Null(r);                                        // "gone" signal → 404 at the endpoint
        Assert.Empty(h.Sessions);                              // nothing inserted
        h.Db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── Existence guard: a user_book owned by SOMEONE ELSE is treated as gone for this user ───────
    [Fact]
    public async Task SubmitAsync_UserBookOwnedByAnotherUser_ReturnsNull()
    {
        var h = new Harness();
        var owner = Guid.NewGuid();
        var otherUser = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var bookId = h.SeedUserBook(owner);                    // owned by `owner`, not `otherUser`

        var r = await h.Service.SubmitAsync(otherUser, siteId, UserBookReq(bookId, started, started.AddMinutes(5)), CancellationToken.None);

        Assert.Null(r);
        Assert.Empty(h.Sessions);
    }

    // ── Existence guard: referenced edition gone → null ──────────────────────────────────────────
    [Fact]
    public async Task SubmitAsync_EditionMissing_ReturnsNull_NoInsert()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var req = EditionReq(Guid.NewGuid(), started, started.AddMinutes(5));   // never seeded

        var r = await h.Service.SubmitAsync(userId, siteId, req, CancellationToken.None);

        Assert.Null(r);
        Assert.Empty(h.Sessions);
        h.Db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── Belt-and-suspenders: FK 23503 on SaveChanges (delete-between-check-and-insert) → benign ack ─
    [Fact]
    public async Task SubmitAsync_SaveThrows23503_ReturnsBenignAck_NoRethrow()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var siteId = Guid.NewGuid();
        var started = new DateTimeOffset(2025, 3, 15, 12, 0, 0, TimeSpan.Zero);
        var editionId = h.SeedEdition();                       // passes the pre-check
        var inner = new Npgsql.PostgresException("fk violation", "ERROR", "ERROR", "23503");
        h.ThrowOnSaveCall = new DbUpdateException("fk violation", inner);

        var r = await h.Service.SubmitAsync(userId, siteId, EditionReq(editionId, started, started.AddMinutes(5)), CancellationToken.None);

        Assert.NotNull(r);                                     // benign ack, not a 500
        Assert.Equal(Guid.Empty, r.SessionId);                 // row was NOT inserted
        Assert.Empty(r.NewAchievements);
    }

    // ── Reader audit L6: achievements are judged on the reader's clock, not UTC's ───────────────
    // 20:00 UTC is 06:00 in UTC+10: an early-bird session there, an evening one in UTC.
    [Theory]
    [InlineData(600, true)]
    [InlineData(0, false)]
    public async Task SubmitAsync_TzOffset_EarlyBirdByLocalHour(int tzMinutes, bool expected)
    {
        var h = new Harness();
        var started = new DateTimeOffset(2025, 3, 15, 20, 0, 0, TimeSpan.Zero);

        var r = await h.Service.SubmitAsync(Guid.NewGuid(), Guid.NewGuid(),
            EditionReq(h.SeedEdition(), started, started.AddMinutes(5)), CancellationToken.None,
            TimeSpan.FromMinutes(tzMinutes));

        Assert.Equal(expected, r!.NewAchievements.Contains("early_bird"));
    }

    // UTC−5, reading at 23:30 local on the 13th and 14th (04:30 UTC the next day) and 10:00 on the
    // 15th: three local days, but only two UTC days.
    [Theory]
    [InlineData(-300, true)]
    [InlineData(0, false)]
    public async Task SubmitAsync_TzOffset_StreakCountsLocalDays(int tzMinutes, bool expected)
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var editionId = h.SeedEdition();
        h.Sessions.Add(SeedSession(userId, editionId, null, new DateTimeOffset(2025, 3, 14, 4, 30, 0, TimeSpan.Zero)));
        h.Sessions.Add(SeedSession(userId, editionId, null, new DateTimeOffset(2025, 3, 15, 4, 30, 0, TimeSpan.Zero)));
        var started = new DateTimeOffset(2025, 3, 15, 15, 0, 0, TimeSpan.Zero);

        var r = await h.Service.SubmitAsync(userId, Guid.NewGuid(),
            EditionReq(editionId, started, started.AddMinutes(5)), CancellationToken.None,
            TimeSpan.FromMinutes(tzMinutes));

        Assert.Equal(expected, r!.NewAchievements.Contains("streak_3"));
    }

    [Theory]
    [InlineData("120", 120)]
    [InlineData("-300", -300)]
    [InlineData("840", 840)]
    [InlineData("99999", 0)]
    [InlineData("abc", 0)]
    [InlineData(null, 0)]
    public void ParseTzOffset_Input_ClampedToRealOffsets(string? tz, int expectedMinutes)
    {
        Assert.Equal(TimeSpan.FromMinutes(expectedMinutes), Api.Endpoints.ReadingTrackingEndpoints.ParseTzOffset(tz));
    }
}
