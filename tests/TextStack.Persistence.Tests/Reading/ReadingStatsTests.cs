using Application.Library;
using Application.Reading;
using Application.Transitional;
using Contracts.Sync;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Reading;

/// <summary>
/// A reader's stats (#1366), from the sessions their devices pushed. Today is the database's (now() in the zone), so the
/// stories read relative to it, in UTC; the exact calendar arithmetic is pinned by the unit tests of ReadingStats.
/// A session on "today" starts at today's midnight, the one instant of today that is never in the future.
/// </summary>
public class ReadingStatsTests(PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly ReadingSessionRepository _sessions = new(db.DataSource);

    private ReadingSyncService Service()
    {
        var library = new BookAccess(new LibraryRepository(db.DataSource));
        return new(library, new ReadingStateRepository(db.DataSource), _sessions, new ChapterReadService(library), TimeProvider.System);
    }

    // The stats' own read of today; the asserts below lean on the response's From/To, so only a run across midnight UTC
    // between this and the stats call could shift the sessions placed from it.
    private async Task<DateOnly> TodayAsync() => (await _sessions.DailyTotalsAsync(Guid.NewGuid(), "UTC", Ct))!.Today;

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

    /// <summary>Midnight UTC of <paramref name="day"/>, plus <paramref name="hours"/> (only for days before today).</summary>
    private static DateTimeOffset At(DateOnly day, int hours = 0) => new(day.ToDateTime(new TimeOnly(hours, 0)), TimeSpan.Zero);

    [Fact]
    public async Task StatsAsync_Week_HasABarForEveryDayAndOnlyThisWeeksTime()
    {
        var user = await db.NewReaderAsync();
        var today = await TodayAsync();
        await ReadAsync(user, At(today), 10 * 60);
        await ReadAsync(user, At(today.AddDays(-7), 10), 60 * 60); // last week
        await ReadAsync(user, At(today), 0); // opened, nothing read

        var stats = await StatsAsync(user, "week");

        Assert.Equal((DayOfWeek.Monday, stats.From.AddDays(6), 7), (stats.From.DayOfWeek, stats.To, stats.Bars.Count));
        Assert.Equal(Enumerable.Range(0, 7).Select(stats.From.AddDays), stats.Bars.Select(b => b.Start));
        Assert.InRange(today, stats.From, stats.To);
        Assert.Equal(10, stats.Bars.Single(b => b.Start == today).Minutes);
        Assert.Equal((10, 1, 10), (stats.Minutes, stats.DaysRead, stats.Bars.Sum(b => b.Minutes)));
    }

    [Fact]
    public async Task DailyTotalsAsync_SessionAt2330UtcInKyiv_LandsOnTheNextDay()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, new DateTimeOffset(2026, 3, 10, 23, 30, 0, TimeSpan.Zero), 600); // 01:30 on the 11th in Kyiv

        var kyiv = await _sessions.DailyTotalsAsync(user, "Europe/Kyiv", Ct);
        var utc = await _sessions.DailyTotalsAsync(user, "UTC", Ct);

        Assert.Equal([new DailyReading(new DateOnly(2026, 3, 11), 600)], kyiv!.Days);
        Assert.Equal([new DailyReading(new DateOnly(2026, 3, 10), 600)], utc!.Days);
    }

    [Fact]
    public async Task StatsAsync_Month_IsEveryDayOfTheMonth()
    {
        var user = await db.NewReaderAsync();
        var first = (await TodayAsync()) is var t ? new DateOnly(t.Year, t.Month, 1) : default;
        await ReadAsync(user, At(first), 60);
        await ReadAsync(user, At(first.AddDays(-1), 10), 60);

        var stats = await StatsAsync(user, "month");

        Assert.Equal((first, stats.From.AddMonths(1).AddDays(-1), DateTime.DaysInMonth(first.Year, first.Month)), (stats.From, stats.To, stats.Bars.Count));
        Assert.Equal((1, 1, 1), (stats.Bars[0].Minutes, stats.Minutes, stats.DaysRead));
    }

    [Fact]
    public async Task StatsAsync_HalfyearAndYear_OneBarPerMonth()
    {
        var user = await db.NewReaderAsync();
        var thisMonth = (await TodayAsync()) is var t ? new DateOnly(t.Year, t.Month, 1) : default;
        await ReadAsync(user, At(thisMonth.AddMonths(-6), 10), 30 * 60); // before the half year
        await ReadAsync(user, At(thisMonth.AddMonths(-5), 10), 10 * 60);
        await ReadAsync(user, At(thisMonth.AddMonths(-5).AddDays(3), 10), 5 * 60);
        await ReadAsync(user, At(thisMonth), 60 * 60);

        var half = await StatsAsync(user, "halfyear");
        var year = await StatsAsync(user, "year");

        Assert.Equal((thisMonth.AddMonths(-5), thisMonth.AddMonths(1).AddDays(-1)), (half.From, half.To));
        Assert.Equal(Enumerable.Range(0, 6).Select(half.From.AddMonths), half.Bars.Select(b => b.Start));
        Assert.Equal((15, 60, 75, 3), (half.Bars[0].Minutes, half.Bars[5].Minutes, half.Minutes, half.DaysRead));
        Assert.Equal((new DateOnly(thisMonth.Year, 1, 1), year.From.AddYears(1).AddDays(-1), 12), (year.From, year.To, year.Bars.Count));
        Assert.Equal(60, year.Bars[thisMonth.Month - 1].Minutes);
    }

    [Fact]
    public async Task StatsAsync_ReadUntilYesterdayNotYetToday_CurrentStreakEndsYesterday()
    {
        var user = await db.NewReaderAsync();
        var today = await TodayAsync();
        foreach (var ago in new[] { 5, 3, 2, 1 }) await ReadAsync(user, At(today.AddDays(-ago), 10), 60);

        var stats = await StatsAsync(user, "week");

        Assert.Equal((3, 3), (stats.CurrentStreak, stats.BestStreak));
    }

    [Fact]
    public async Task StatsAsync_LongerRunLongAgo_IsTheBestStreakOverAllTime()
    {
        var user = await db.NewReaderAsync();
        var today = await TodayAsync();
        for (var ago = 100; ago < 112; ago++) await ReadAsync(user, At(today.AddDays(-ago), 10), 60);
        await ReadAsync(user, At(today), 60);
        await ReadAsync(user, At(today.AddDays(-2), 10), 60); // a gap before today: no run

        var stats = await StatsAsync(user, "week");

        Assert.Equal((1, 12), (stats.CurrentStreak, stats.BestStreak));
    }

    [Fact]
    public async Task StatsAsync_SessionOfADeletedBook_StillCounts()
    {
        var book = await db.NewReaderWithBookAsync();
        await ReadAsync(book.UserId, At(await TodayAsync()), 15 * 60, book.Id);
        await db.ExecAsync("DELETE FROM books WHERE id = @Id", new { book.Id });

        var stats = await StatsAsync(book.UserId, "week");

        Assert.Equal((15, 1, 1), (stats.Minutes, stats.DaysRead, stats.CurrentStreak));
    }

    [Fact]
    public async Task StatsAsync_SessionStartingInTheFuture_IsNotCountedYet()
    {
        var user = await db.NewReaderAsync();
        await ReadAsync(user, DateTimeOffset.UtcNow.AddHours(1), 60 * 60); // a device clock running ahead

        var stats = await StatsAsync(user, "week");

        Assert.Equal((0, 0, 0, 0), (stats.Minutes, stats.DaysRead, stats.CurrentStreak, stats.BestStreak));
    }

    [Fact]
    public async Task StatsAsync_AnotherReadersSessions_AreNotCounted()
    {
        var alice = await db.NewReaderAsync();
        var bob = await db.NewReaderAsync();
        await ReadAsync(alice, At(await TodayAsync()), 60 * 60);

        var stats = await StatsAsync(bob, "week");

        Assert.Equal((0, 0, 0, 0), (stats.Minutes, stats.DaysRead, stats.CurrentStreak, stats.BestStreak));
    }

    [Theory]
    [InlineData("week", null, "tz")]
    [InlineData("week", " ", "tz")]
    [InlineData("week", "Mars/Olympus", "tz")] // well shaped: refused by Postgres (22023)
    [InlineData("week", "GMT+03:00", "tz")] // POSIX shapes: Postgres would flip the sign
    [InlineData("week", "+03:00", "tz")]
    [InlineData("week", "UTC+3", "tz")]
    [InlineData("week", "UTC\0", "tz")] // a control char: refused before it reaches Postgres
    [InlineData("week", "Europe/Kyiv\n", "tz")]
    [InlineData("day", "UTC", "period")]
    [InlineData(null, "UTC", "period")]
    public async Task StatsAsync_BadPeriodOrZone_IsInvalidPayload(string? period, string? tz, string field)
    {
        var result = await Service().StatsAsync(Guid.NewGuid(), period, tz, Ct);

        Assert.Equal(400, result.Status);
        Assert.Equal(field, Assert.IsType<SyncError>(result.Body).Field);
    }

    [Theory]
    [InlineData("Etc/GMT+3")]
    [InlineData("America/Argentina/Buenos_Aires")]
    [InlineData("UTC")]
    public async Task StatsAsync_IanaZone_IsAccepted(string tz) => await StatsAsync(Guid.NewGuid(), "week", tz);
}
