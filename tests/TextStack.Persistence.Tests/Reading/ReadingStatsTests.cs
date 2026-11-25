using Application.Library;
using Application.Reading;
using Application.Transitional;
using Contracts.Sync;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Reading;

/// <summary>
/// A reader's stats (#1366), from the sessions their devices pushed: days are the reader's own (their zone),
/// periods are calendar ones, streaks run over all time. Today is Wednesday 2026-11-25, noon UTC.
/// </summary>
public class ReadingStatsTests(PostgresFixture db)
{
    private static readonly DateTimeOffset Now = new(2026, 11, 25, 12, 0, 0, TimeSpan.Zero);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly ReadingSessionRepository _sessions = new(db.DataSource);

    private ReadingSyncService Service()
    {
        var library = new BookAccess(new LibraryRepository(db.DataSource));
        return new(library, new ReadingStateRepository(db.DataSource), _sessions, new ChapterReadService(library), new Clock(Now));
    }

    private async Task<ReadingStatsDto> StatsAsync(Guid userId, string period, string tz = "UTC")
    {
        var result = await Service().StatsAsync(userId, period, tz, Ct);
        Assert.Equal(200, result.Status);
        return Assert.IsType<ReadingStatsDto>(result.Body);
    }

    private Task ReadAsync(Guid userId, DateTimeOffset startedAt, int seconds, Guid? bookId = null) =>
        _sessions.SaveAsync(userId, new ReadingSession
        {
            ClientSessionId = Guid.NewGuid(),
            BookId = bookId,
            StartedAt = startedAt,
            EndedAt = startedAt.AddSeconds(seconds),
            DurationSeconds = seconds,
            WordsRead = 0,
            StartPercent = 0,
            EndPercent = 0,
        }, Ct);

    private static DateTimeOffset At(int month, int day, int hour = 10, int minute = 0) => new(2026, month, day, hour, minute, 0, TimeSpan.Zero);

    [Fact]
    public async Task StatsAsync_Week_IsMondayToSundayWithAZeroBarForEveryDayNotRead()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, At(11, 23), 20 * 60);
        await ReadAsync(user, At(11, 25), 10 * 60);
        await ReadAsync(user, At(11, 25, 18), 5 * 60 + 30);
        await ReadAsync(user, At(11, 22), 60 * 60); // last Sunday: another week
        await ReadAsync(user, At(11, 24), 0); // opened, nothing read

        var stats = await StatsAsync(user, "week");

        Assert.Equal(("week", new DateOnly(2026, 11, 23), new DateOnly(2026, 11, 29)), (stats.Period, stats.From, stats.To));
        Assert.Equal([20, 0, 16, 0, 0, 0, 0], stats.Bars.Select(b => b.Minutes));
        Assert.Equal(new DateOnly(2026, 11, 23), stats.Bars[0].Start);
        Assert.Equal((36, 2), (stats.Minutes, stats.DaysRead));
    }

    [Fact]
    public async Task StatsAsync_SessionAt2330UtcInKyiv_CountsOnTheNextDay()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, At(11, 23, 23, 30), 10 * 60); // 01:30 on Tuesday in Kyiv

        var kyiv = await StatsAsync(user, "week", "Europe/Kyiv");
        var utc = await StatsAsync(user, "week");

        Assert.Equal([0, 10, 0, 0, 0, 0, 0], kyiv.Bars.Select(b => b.Minutes));
        Assert.Equal([10, 0, 0, 0, 0, 0, 0], utc.Bars.Select(b => b.Minutes));
    }

    [Fact]
    public async Task StatsAsync_Month_IsEveryDayOfTheMonth()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, At(11, 1), 60);
        await ReadAsync(user, At(10, 31), 60);

        var stats = await StatsAsync(user, "month");

        Assert.Equal((new DateOnly(2026, 11, 1), new DateOnly(2026, 11, 30), 30), (stats.From, stats.To, stats.Bars.Count));
        Assert.Equal((1, 1, 1), (stats.Bars[0].Minutes, stats.Minutes, stats.DaysRead));
    }

    [Fact]
    public async Task StatsAsync_HalfyearAndYear_OneBarPerCalendarMonth()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, At(6, 1), 30 * 60); // before the half year, in the year
        await ReadAsync(user, At(7, 15), 10 * 60);
        await ReadAsync(user, At(7, 31), 5 * 60);
        await ReadAsync(user, At(11, 2), 60 * 60);

        var half = await StatsAsync(user, "halfyear");
        var year = await StatsAsync(user, "year");

        Assert.Equal((new DateOnly(2026, 6, 1), new DateOnly(2026, 11, 30)), (half.From, half.To));
        Assert.Equal([(new DateOnly(2026, 6, 1), 30), (new DateOnly(2026, 7, 1), 15), (new DateOnly(2026, 8, 1), 0),
            (new DateOnly(2026, 9, 1), 0), (new DateOnly(2026, 10, 1), 0), (new DateOnly(2026, 11, 1), 60)], half.Bars.Select(b => (b.Start, b.Minutes)));
        Assert.Equal((new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31), 12), (year.From, year.To, year.Bars.Count));
        Assert.Equal((105, 4), (year.Minutes, year.DaysRead));
    }

    [Fact]
    public async Task StatsAsync_ReadUntilYesterdayNotYetToday_CurrentStreakEndsYesterday()
    {
        var user = await db.NewReaderAsync();
        foreach (var day in new[] { 20, 22, 23, 24 }) await ReadAsync(user, At(11, day), 60);

        var stats = await StatsAsync(user, "week");

        Assert.Equal((3, 3), (stats.CurrentStreak, stats.BestStreak));
    }

    [Fact]
    public async Task StatsAsync_LongerRunMonthsAgo_IsTheBestStreakOverAllTime()
    {
        var user = await db.NewReaderAsync();
        for (var day = 1; day <= 12; day++) await ReadAsync(user, At(3, day), 60);
        await ReadAsync(user, At(11, 25), 60);
        await ReadAsync(user, At(11, 22), 60); // a gap before today: no run

        var stats = await StatsAsync(user, "week");

        Assert.Equal((1, 12), (stats.CurrentStreak, stats.BestStreak));
    }

    [Fact]
    public async Task StatsAsync_SessionOfADeletedBook_StillCounts()
    {
        var book = await db.NewReaderWithBookAsync();
        await ReadAsync(book.UserId, At(11, 25), 15 * 60, book.Id);
        await db.ExecAsync("DELETE FROM books WHERE id = @Id", new { book.Id });

        var stats = await StatsAsync(book.UserId, "week");

        Assert.Equal((15, 1, 1), (stats.Minutes, stats.DaysRead, stats.CurrentStreak));
    }

    [Fact]
    public async Task StatsAsync_AnotherReadersSessions_AreNotCounted()
    {
        var alice = await db.NewReaderAsync();
        var bob = await db.NewReaderAsync();
        await ReadAsync(alice, At(11, 25), 60 * 60);

        var stats = await StatsAsync(bob, "week");

        Assert.Equal((0, 0, 0, 0), (stats.Minutes, stats.DaysRead, stats.CurrentStreak, stats.BestStreak));
    }

    [Theory]
    [InlineData("week", null, "tz")]
    [InlineData("week", "Mars/Olympus", "tz")]
    [InlineData("day", "UTC", "period")]
    [InlineData(null, "UTC", "period")]
    public async Task StatsAsync_BadPeriodOrZone_IsInvalidPayload(string? period, string? tz, string field)
    {
        var result = await Service().StatsAsync(Guid.NewGuid(), period, tz, Ct);

        Assert.Equal(400, result.Status);
        Assert.Equal(field, Assert.IsType<SyncError>(result.Body).Field);
    }

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
