using System.Diagnostics;
using Api.Sync;
using Infrastructure.Persistence;
using Microsoft.Extensions.Logging.Abstractions;

namespace TextStack.UnitTests.Sync;

/// <summary><see cref="SyncReadiness"/> on a faked ledger: the states a healthy stack cannot produce, the cache and its cap.</summary>
public class SyncReadinessTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Configured, never opened: every test fakes the ledger read.
    private static readonly AppDataSource Configured = new("Host=127.0.0.1;Port=1;Database=textstack_v2");

    internal static SyncReadiness Readiness(Func<CancellationToken, Task<List<string>>> readPending, TimeSpan? checkTimeout = null, TimeProvider? clock = null) =>
        new(Configured, clock ?? TimeProvider.System, NullLogger<SyncReadiness>.Instance, readPending, checkTimeout);

    [Fact]
    public async Task GetAsync_LedgerWithAPendingMigration_IsBehindAndNotReady()
    {
        var state = await Readiness(_ => Task.FromResult(new List<string> { "0002_next" })).GetAsync();

        Assert.Equal((ReadinessState.Behind, false, "0002_next"), (state.Status, state.IsReady, Assert.Single(state.Pending!)));
    }

    [Fact]
    public async Task GetAsync_NoConnectionString_IsUnconfiguredWithoutACheck()
    {
        var checks = 0;
        var readiness = new SyncReadiness(new AppDataSource(null), TimeProvider.System, NullLogger<SyncReadiness>.Instance,
            _ => { checks++; return Task.FromResult(new List<string>()); });

        Assert.Equal((ReadinessState.Unconfigured, 0), ((await readiness.GetAsync()).Status, checks));
    }

    [Fact]
    public async Task GetAsync_CheckThatNeverAnswers_GivesUpAtTheCheckTimeout()
    {
        // A blackholed host: the connect waits for the token and nothing else.
        var hung = Readiness(async ct => { await Task.Delay(Timeout.Infinite, ct); return []; }, TimeSpan.FromMilliseconds(200));

        var watch = Stopwatch.StartNew();
        var state = await hung.GetAsync().WaitAsync(TimeSpan.FromSeconds(3), Ct);

        Assert.Equal(ReadinessState.Unreachable, state.Status);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"took {watch.Elapsed}");
    }

    [Fact]
    public async Task GetAsync_WithinTheTtl_SharesOneCheckAndAfterItOrAnInvalidateChecksAgain()
    {
        var checks = 0;
        var clock = new SteppedClock();
        var readiness = Readiness(_ => { checks++; return Task.FromResult(new List<string>()); }, clock: clock);

        await readiness.GetAsync();
        clock.Now += SyncReadiness.Ttl - TimeSpan.FromSeconds(1);
        await readiness.GetAsync();
        Assert.Equal(1, checks);

        clock.Now += TimeSpan.FromSeconds(1);
        await readiness.GetAsync();
        readiness.Invalidate();
        await readiness.GetAsync();
        Assert.Equal(3, checks);
    }
}
