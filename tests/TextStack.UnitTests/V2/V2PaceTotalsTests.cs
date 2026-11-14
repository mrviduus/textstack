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
using Npgsql;

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
        public Task<PaceTotals> NativePaceTotalsAsync(Guid userId, CancellationToken ct)
        {
            Calls++;
            return totals(ct);
        }
    }

    /// <summary>A readiness that counts its probes: this stats path must never cause one.</summary>
    private sealed class Probes
    {
        public int Count;
        public V2Readiness Readiness { get; }
        public Probes() => Readiness = V2ReadinessTests.Readiness(_ => { Count++; return Task.FromResult(new List<string>()); });
    }

    private static V2PaceTotals Totals(Sessions sessions, bool on = true, Probes? probes = null, SteppedClock? clock = null, int timeoutMs = 200) => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = on ? "true" : "false" }).Build(),
        sessions, (probes ?? new Probes()).Readiness, clock ?? new SteppedClock(), NullLogger<V2PaceTotals>.Instance)
    { Timeout = TimeSpan.FromMilliseconds(timeoutMs) };

    private static Sessions Hanging() => new(async ct => { await Task.Delay(Timeout.Infinite, ct); return Some; });

    [Fact]
    public async Task GetAsync_On_TheRepositorysTotalsWithoutProbingReadiness()
    {
        var probes = new Probes();

        Assert.Equal((Some, 0), (await Totals(new Sessions(_ => Task.FromResult(Some)), probes: probes).GetAsync(Guid.NewGuid(), Ct), probes.Count));
    }

    [Fact]
    public async Task GetAsync_FeatureOff_NoneWithoutAsking()
    {
        var sessions = new Sessions(_ => Task.FromResult(Some));

        Assert.Equal((default(PaceTotals), 0), (await Totals(sessions, on: false).GetAsync(Guid.NewGuid(), Ct), sessions.Calls));
    }

    [Fact]
    public async Task GetAsync_QueryIgnoresItsToken_NoneWithinTheLimit()
    {
        var never = new TaskCompletionSource<PaceTotals>();

        var watch = System.Diagnostics.Stopwatch.StartNew();
        var totals = await Totals(new Sessions(_ => never.Task)).GetAsync(Guid.NewGuid(), Ct).WaitAsync(TimeSpan.FromSeconds(5), Ct);

        Assert.Equal(default, totals);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"took {watch.Elapsed}");
    }

    [Fact]
    public async Task GetAsync_AfterATimeout_SkipsV2For30sThenAsksAgain_ReadinessUntouched()
    {
        var clock = new SteppedClock();
        var probes = new Probes();
        var sessions = Hanging();
        var totals = Totals(sessions, probes: probes, clock: clock);

        Assert.Equal(default, await totals.GetAsync(Guid.NewGuid(), Ct));
        clock.Now += V2PaceTotals.SkipFor - TimeSpan.FromSeconds(1);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(default, await totals.GetAsync(Guid.NewGuid(), Ct));
        Assert.True(watch.Elapsed < TimeSpan.FromMilliseconds(100), $"took {watch.Elapsed}");
        Assert.Equal(1, sessions.Calls);
        clock.Now += TimeSpan.FromSeconds(2);
        await totals.GetAsync(Guid.NewGuid(), Ct);

        Assert.Equal((2, 0, V2State.Ready), (sessions.Calls, probes.Count, (await probes.Readiness.GetAsync()).Status));
    }

    [Fact]
    public async Task GetAsync_AnyFailure_NoneAndSkipped()
    {
        var sessions = new Sessions(_ => throw new InvalidOperationException("v2 down"));
        var totals = Totals(sessions);

        Assert.Equal(default, await totals.GetAsync(Guid.NewGuid(), Ct));
        Assert.Equal(default, await totals.GetAsync(Guid.NewGuid(), Ct));
        Assert.Equal(1, sessions.Calls);
    }

    [Fact]
    public async Task GetAsync_NpgsqlFailure_ObservedByReadiness_OtherFailureNot()
    {
        var npgsql = new Probes();
        var other = new Probes();
        await npgsql.Readiness.GetAsync();
        await other.Readiness.GetAsync();

        await Totals(new Sessions(_ => throw new NpgsqlException("connection refused")), probes: npgsql).GetAsync(Guid.NewGuid(), Ct);
        await Totals(new Sessions(_ => throw new InvalidOperationException("v2 down")), probes: other).GetAsync(Guid.NewGuid(), Ct);
        await npgsql.Readiness.GetAsync();
        await other.Readiness.GetAsync();

        // Observe drops the cached check: the next reader of readiness checks again.
        Assert.Equal((2, 1), (npgsql.Count, other.Count));
    }

    [Fact]
    public async Task GetAsync_CallersOwnCancel_ThrownAndNothingSkipped()
    {
        using var mine = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        mine.CancelAfter(TimeSpan.FromMilliseconds(100));
        var sessions = new Sessions(async ct => { await Task.Delay(Timeout.Infinite, ct); return Some; });
        var totals = Totals(sessions, timeoutMs: 10_000);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => totals.GetAsync(Guid.NewGuid(), mine.Token));
        using var later = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        later.CancelAfter(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => totals.GetAsync(Guid.NewGuid(), later.Token));

        Assert.Equal(2, sessions.Calls);
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
