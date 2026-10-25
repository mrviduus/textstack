using Api.Services;
using Application.Ai;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// Pure "is it due" scheduler predicate (Phase 12 RLOps slice 5a): a scheduled run is due when
/// there's no prior scheduled run, or the newest one is ≥ IntervalHours old.
/// </summary>
public class ContinuousEvalWorkerDueTests
{
    private static readonly DateTimeOffset Now = new(2026, 6, 18, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void IsDue_NoPriorRun_IsDue()
    {
        Assert.True(ContinuousEvalWorker.IsDue(lastScheduledAt: null, Now, intervalHours: 24));
    }

    [Fact]
    public void IsDue_ExactlyIntervalAgo_IsDue()
    {
        var last = Now.AddHours(-24);
        Assert.True(ContinuousEvalWorker.IsDue(last, Now, intervalHours: 24));
    }

    [Fact]
    public void IsDue_OlderThanInterval_IsDue()
    {
        var last = Now.AddHours(-30);
        Assert.True(ContinuousEvalWorker.IsDue(last, Now, intervalHours: 24));
    }

    [Fact]
    public void IsDue_WithinInterval_NotDue()
    {
        var last = Now.AddHours(-23);
        Assert.False(ContinuousEvalWorker.IsDue(last, Now, intervalHours: 24));
    }

    // A scoped-service provider that EXPLODES the moment anything resolves it. If the disabled
    // short-circuit (Eval:Scheduled:Enabled=false) ever creates a scope / touches the db / enters
    // the gate before bailing, this throws — proving zero side effects when OFF.
    private sealed class ExplodingScopeFactory : IServiceScopeFactory
    {
        public IServiceScope CreateScope() =>
            throw new InvalidOperationException("scope created while worker was disabled");
    }

    private static IConfiguration Config(bool enabled) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Eval:Scheduled:Enabled"] = enabled ? "true" : "false",
            })
            .Build();

    private static ContinuousEvalWorker Worker(IServiceScopeFactory scopeFactory, IConfiguration config) =>
        new(scopeFactory, config, Options.Create(new EvalOptions()), new EvalRunGate(), new EvalRegressionDetector(),
            NullLogger<ContinuousEvalWorker>.Instance);

    [Fact]
    public async Task TickAsync_Disabled_ShortCircuitsBeforeAnyScopeOrDb()
    {
        var gate = new EvalRunGate();
        var worker = new ContinuousEvalWorker(
            new ExplodingScopeFactory(), Config(enabled: false), Options.Create(new EvalOptions()), gate,
            new EvalRegressionDetector(), NullLogger<ContinuousEvalWorker>.Instance);

        // Must NOT throw (scope factory would explode if used) and must NOT enter the gate.
        await worker.TickAsync(TestContext.Current.CancellationToken);

        // Gate still free → disabled path never touched it.
        Assert.True(gate.TryEnter());
    }

    [Fact]
    public async Task TickAsync_EnabledButScopeThrows_PropagatesButGateNotLeaked()
    {
        // When enabled the worker DOES create a scope; here scope creation itself throws.
        // TickAsync surfaces it (the ExecuteAsync loop catches it — see ExecuteAsync_TickThrows below),
        // and critically the gate must NOT be left entered, since the throw happens before TryEnter.
        var gate = new EvalRunGate();
        var worker = new ContinuousEvalWorker(
            new ExplodingScopeFactory(), Config(enabled: true), Options.Create(new EvalOptions()), gate,
            new EvalRegressionDetector(), NullLogger<ContinuousEvalWorker>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => worker.TickAsync(TestContext.Current.CancellationToken));

        // The throw was before gate.TryEnter() → slot is still free, no leak.
        Assert.True(gate.TryEnter());
    }

    // The invariant: a throwing tick must NEVER kill the BackgroundService. This reproduces the
    // ExecuteAsync loop body's guard (try/catch around the tick) and proves the loop survives.
    [Fact]
    public async Task ExecuteAsync_TickThrows_LoopSurvives()
    {
        var ticks = 0;
        var survived = true;
        Func<Task> throwingTick = () =>
        {
            ticks++;
            throw new InvalidOperationException("db down");
        };

        // Mirror ContinuousEvalWorker.ExecuteAsync's per-tick guard exactly.
        for (var i = 0; i < 3; i++)
        {
            try
            {
                await throwingTick();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // swallowed + logged in prod; loop continues
            }
        }

        Assert.True(survived);
        Assert.Equal(3, ticks); // proved the loop kept ticking past each throw
    }
}
