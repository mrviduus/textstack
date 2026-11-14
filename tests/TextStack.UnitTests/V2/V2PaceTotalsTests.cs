using Api.V2;
using Application.Common;
using Application.Common.Interfaces;
using Application.Reading;
using Application.ReadingTracking;
using Contracts.ReadingTracking;
using Domain.Reading;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary><see cref="V2PaceTotals"/>: the V2 sessions in the legacy pace (#1313), and none whenever V2 cannot answer.</summary>
public class V2PaceTotalsTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly PaceTotals Some = new(3, 4500, 900);

    private sealed class Sessions(Func<CancellationToken, Task<PaceTotals>> totals) : IReadingSessionRepository
    {
        public int Calls { get; private set; }
        public Task<WriteResult<ReadingSession>> SaveAsync(Guid userId, ReadingSession session, CancellationToken ct) => throw new NotSupportedException();
        public Task<PaceTotals> PaceTotalsAsync(Guid userId, CancellationToken ct)
        {
            Calls++;
            return totals(ct);
        }
    }

    private static V2PaceTotals Totals(Sessions sessions, bool on = true, bool ready = true) => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = on ? "true" : "false" }).Build(),
        V2ReadinessTests.Readiness(_ => Task.FromResult(ready ? new List<string>() : ["0099_next"])),
        sessions, NullLogger<V2PaceTotals>.Instance)
    { Timeout = TimeSpan.FromMilliseconds(200) };

    [Fact]
    public async Task GetAsync_OnAndReady_TheRepositorysTotals()
    {
        Assert.Equal(Some, await Totals(new Sessions(_ => Task.FromResult(Some))).GetAsync(Guid.NewGuid(), Ct));
    }

    [Fact]
    public async Task GetAsync_FeatureOff_NoneWithoutAsking()
    {
        var sessions = new Sessions(_ => Task.FromResult(Some));

        Assert.Equal((default(PaceTotals), 0), (await Totals(sessions, on: false).GetAsync(Guid.NewGuid(), Ct), sessions.Calls));
    }

    [Fact]
    public async Task GetAsync_NotReady_NoneWithoutAsking()
    {
        var sessions = new Sessions(_ => Task.FromResult(Some));

        Assert.Equal((default(PaceTotals), 0), (await Totals(sessions, ready: false).GetAsync(Guid.NewGuid(), Ct), sessions.Calls));
    }

    [Fact]
    public async Task GetAsync_QueryFailsOrHangs_None()
    {
        var failing = Totals(new Sessions(_ => throw new InvalidOperationException("v2 down")));
        var hanging = Totals(new Sessions(async ct => { await Task.Delay(Timeout.Infinite, ct); return Some; }));

        Assert.Equal(default, await failing.GetAsync(Guid.NewGuid(), Ct));
        Assert.Equal(default, await hanging.GetAsync(Guid.NewGuid(), Ct).WaitAsync(TimeSpan.FromSeconds(3), Ct));
    }

    [Fact]
    public async Task ReadingPace_OneLegacySessionAndTwoV2_IsTheReadersOwnFromAllThree()
    {
        var userId = Guid.NewGuid();
        var legacy = new List<Domain.Entities.ReadingSession> { new() { Id = Guid.NewGuid(), UserId = userId, DurationSeconds = 300, WordsRead = 1500 } };
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.ReadingSessions).Returns(() => FakeSet(legacy).Object);
        var v2 = new Mock<IV2PaceTotals>();
        v2.Setup(x => x.GetAsync(userId, It.IsAny<CancellationToken>())).ReturnsAsync(new PaceTotals(2, 1500, 600));

        // 3000 words in 900 s: 200 wpm, the reader's own (three sessions); legacy's one alone is the fallback.
        Assert.Equal(new ReadingPaceDto(200, 3, true), await ReadingPace.GetAsync(db.Object, userId, Ct, v2.Object));
        Assert.Equal(new ReadingPaceDto(ReadingPace.FallbackWpm, 1, false), await ReadingPace.GetAsync(db.Object, userId, Ct));
    }

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
        return set;
    }
}
