using Application.Ai;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// In-memory per-feature daily spend tracking (Phase 12 RLOps slice 4): Interlocked increments,
/// UTC day rollover via TimeProvider, lazy seed scaled by 1/sampleRate, the 80% alert (once on
/// crossing + dedup same day + refires next day), and best-effort failure swallowing.
/// </summary>
public class RollingSpendTrackerTests
{
    private static readonly DateTimeOffset Day1 = new(2026, 6, 18, 10, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Day2 = new(2026, 6, 19, 10, 0, 0, TimeSpan.Zero);

    // ---- Record + SpentTodayUsd ----

    [Fact]
    public void Record_Increments_SpentTodaySums()
    {
        var t = Build(out _, out _);
        t.Record("explain", 0.5m);
        t.Record("explain", 0.25m);
        Assert.Equal(0.75m, t.SpentTodayUsd("explain"));
    }

    [Fact]
    public void SpentTodayUsd_UnknownFeature_Zero()
    {
        var t = Build(out _, out _);
        Assert.Equal(0m, t.SpentTodayUsd("never-touched"));
    }

    [Fact]
    public void Record_Concurrent_SumsExactly_ViaInterlocked()
    {
        var t = Build(out _, out _);
        Parallel.For(0, 1000, _ => t.Record("explain", 0.001m));
        Assert.Equal(1.0m, t.SpentTodayUsd("explain"));
    }

    [Fact]
    public void Record_NanoCost_MicroDollarRoundTrip_Precise()
    {
        var t = Build(out _, out _);
        // 0.000001 USD = exactly 1 micro-dollar; 1000 of them = 0.001 USD.
        for (var i = 0; i < 1000; i++)
            t.Record("explain", 0.000001m);
        Assert.Equal(0.001m, t.SpentTodayUsd("explain"));
    }

    // ---- Day rollover ----

    [Fact]
    public void DayRollover_ResetsSpend()
    {
        var clock = new SteppedClock { Now = Day1 };
        var t = Build(out _, out _, clock: clock);

        t.Record("explain", 2.0m);
        Assert.Equal(2.0m, t.SpentTodayUsd("explain"));

        clock.Now = Day2; // new UTC day
        Assert.Equal(0m, t.SpentTodayUsd("explain")); // fresh bucket
        t.Record("explain", 0.3m);
        Assert.Equal(0.3m, t.SpentTodayUsd("explain"));
    }

    // ---- Lazy seed ----

    [Fact]
    public void LazySeed_ScalesBy_InverseSampleRate()
    {
        // explain sampled at 0.1 → seed = tracedSum * 10.
        var traces = new List<LlmTrace>
        {
            Trace("explain", 0.05m, Day1),
            Trace("explain", 0.05m, Day1),
        };
        var tracing = new TracingOptions(1.0, new Dictionary<string, double> { ["explain"] = 0.1 });
        var t = Build(out _, out _, clock: new SteppedClock { Now = Day1 }, traces: traces, tracing: tracing);

        // 0.10 traced * (1/0.1) = 1.00 estimated.
        Assert.Equal(1.0m, t.SpentTodayUsd("explain"));
    }

    [Fact]
    public void LazySeed_DefaultRate_NoScale()
    {
        var traces = new List<LlmTrace> { Trace("translate", 0.4m, Day1) };
        var t = Build(out _, out _, clock: new SteppedClock { Now = Day1 }, traces: traces);
        Assert.Equal(0.4m, t.SpentTodayUsd("translate")); // default rate 1.0 → unscaled
    }

    [Fact]
    public void LazySeed_RunsOnce_ThenLiveRecordsAddOnTop()
    {
        var traces = new List<LlmTrace> { Trace("explain", 0.05m, Day1) };
        var tracing = new TracingOptions(1.0, new Dictionary<string, double> { ["explain"] = 0.1 });
        var t = Build(out var scopeFactory, out _, clock: new SteppedClock { Now = Day1 }, traces: traces, tracing: tracing);

        Assert.Equal(0.5m, t.SpentTodayUsd("explain")); // 0.05 * 10 (seeded)
        t.Record("explain", 1.0m);
        Assert.Equal(1.5m, t.SpentTodayUsd("explain")); // seed not re-applied
        Assert.Equal(1, scopeFactory.ScopesCreated); // seed queried DB exactly once
    }

    // ---- 80% alert ----

    [Fact]
    public void Alert_FiresOnce_OnCrossing_80Percent()
    {
        var email = new Mock<IEmailService>();
        var t = Build(out _, out email, budgets: Budget("explain", daily: 10m, BudgetMode.HardStop), clock: new SteppedClock { Now = Day1 });

        t.Record("explain", 7.0m); // 70% — below threshold, no alert
        t.Record("explain", 1.5m); // crosses to 85% — ONE alert

        Eventually(() => email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once));
    }

    [Fact]
    public void Alert_ManyCallsOverThreshold_ExactlyOneEmail_NoStorm()
    {
        // Edge-trigger + dedup: once over 80%, hammering with 100 more over-budget Records
        // must NOT spam — exactly one email total.
        var t = Build(out _, out var email, budgets: Budget("explain", 10m, BudgetMode.HardStop), clock: new SteppedClock { Now = Day1 });

        t.Record("explain", 8.5m); // crosses 80% → the single alert
        for (var i = 0; i < 100; i++)
            t.Record("explain", 1.0m); // all well over 80%/100% — must not re-alert

        // The alert email is fire-and-forget — poll until the one alert lands (don't
        // Thread.Sleep a fixed 100ms, which flakes on a slow CI runner before the
        // dispatched Task runs). The per-(feature,day) dedup guarantees it can never
        // become Times.Exactly(2), so settling on Times.Once is sufficient.
        Eventually(() => email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once));
    }

    [Fact]
    public void Alert_ConcurrentCrossing_ExactlyOneEmail()
    {
        // 200 parallel Records that together cross 80% — dedup must still yield exactly one email.
        var t = Build(out _, out var email, budgets: Budget("explain", 10m, BudgetMode.Fallback), clock: new SteppedClock { Now = Day1 });
        Parallel.For(0, 200, _ => t.Record("explain", 0.1m)); // sums to $20, well over 80%

        // The alert email is fire-and-forget — poll (don't Thread.Sleep a fixed 100ms,
        // which flakes on a slow CI runner before the dispatched Task runs).
        Eventually(() => email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once));
    }

    [Fact]
    public void Alert_DedupsSameDay()
    {
        var t = Build(out _, out var email, budgets: Budget("explain", 10m, BudgetMode.Fallback), clock: new SteppedClock { Now = Day1 });

        t.Record("explain", 8.5m); // crosses 80% → alert
        t.Record("explain", 1.0m); // already alerted today → no second alert

        Eventually(() => email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once));
    }

    [Fact]
    public void Alert_Refires_NextDay()
    {
        var clock = new SteppedClock { Now = Day1 };
        var t = Build(out _, out var email, budgets: Budget("explain", 10m, BudgetMode.HardStop), clock: clock);

        t.Record("explain", 9.0m); // day1 alert
        clock.Now = Day2;
        t.Record("explain", 9.0m); // day2 alert (fresh dedup)

        Eventually(() => email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Exactly(2)));
    }

    [Fact]
    public void Alert_NotFired_WhenBudgetOff()
    {
        var t = Build(out _, out var email, budgets: BudgetOptions.Empty, clock: new SteppedClock { Now = Day1 });
        t.Record("explain", 1000m);
        // Give any (wrongly) scheduled alert a chance, then assert none.
        Thread.Sleep(50);
        email.Verify(e => e.SendAdminAlertAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void SeedFailure_Swallowed_SpentTreatedAsZero()
    {
        // A scope factory whose DbContext throws on access → seed fails → bucket starts at 0.
        var scopeFactory = new ThrowingScopeFactory();
        var t = new RollingSpendTracker(
            scopeFactory, new SteppedClock { Now = Day1 }, BudgetOptions.Empty,
            new TracingOptions(), NullLogger<RollingSpendTracker>.Instance);

        Assert.Equal(0m, t.SpentTodayUsd("explain")); // no throw
        t.Record("explain", 0.5m);
        Assert.Equal(0.5m, t.SpentTodayUsd("explain")); // live record still works
    }

    // ---- harness ----

    private static void Eventually(Action assert, int timeoutMs = 2000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            try { assert(); return; }
            catch (MockException) when (DateTime.UtcNow < deadline) { Thread.Sleep(20); }
        }
    }

    private static BudgetOptions Budget(string feature, decimal daily, BudgetMode mode) =>
        new(new FeatureBudget(null, null, BudgetMode.Off),
            new Dictionary<string, FeatureBudget> { [feature] = new(daily, "ollama", mode) });

    private static LlmTrace Trace(string feature, decimal cost, DateTimeOffset at) => new()
    {
        Id = Guid.NewGuid(),
        FeatureTag = feature,
        ModelId = "m",
        PromptHash = "h",
        MessagesJson = "[]",
        CostUsd = cost,
        CreatedAt = at,
    };

    private static RollingSpendTracker Build(
        out RecordingScopeFactory scopeFactory,
        out Mock<IEmailService> email,
        BudgetOptions? budgets = null,
        SteppedClock? clock = null,
        List<LlmTrace>? traces = null,
        TracingOptions? tracing = null)
    {
        email = new Mock<IEmailService>();
        email.Setup(e => e.SendAdminAlertAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        scopeFactory = new RecordingScopeFactory(traces ?? new List<LlmTrace>(), email.Object);

        return new RollingSpendTracker(
            scopeFactory,
            clock ?? new SteppedClock { Now = Day1 },
            budgets ?? BudgetOptions.Empty,
            tracing ?? new TracingOptions(),
            NullLogger<RollingSpendTracker>.Instance);
    }

    // A scope factory that resolves IAppDbContext (Moq-backed LlmTraces) + IEmailService.
    private sealed class RecordingScopeFactory(List<LlmTrace> traces, IEmailService email) : IServiceScopeFactory
    {
        private int _scopes;
        public int ScopesCreated => Volatile.Read(ref _scopes);

        public IServiceScope CreateScope()
        {
            Interlocked.Increment(ref _scopes);
            return new Scope(traces, email);
        }

        private sealed class Scope(List<LlmTrace> traces, IEmailService email) : IServiceScope
        {
            public IServiceProvider ServiceProvider { get; } = BuildProvider(traces, email);
            public void Dispose() { }

            private static IServiceProvider BuildProvider(List<LlmTrace> traces, IEmailService email)
            {
                var db = new Mock<IAppDbContext>();
                db.Setup(x => x.LlmTraces).Returns(() => FakeSet(traces).Object);

                var services = new ServiceCollection();
                services.AddScoped(_ => db.Object);
                services.AddScoped(_ => email);
                return services.BuildServiceProvider();
            }
        }
    }

    private sealed class ThrowingScopeFactory : IServiceScopeFactory
    {
        public IServiceScope CreateScope() => new Scope();

        private sealed class Scope : IServiceScope
        {
            public IServiceProvider ServiceProvider { get; }
            public Scope()
            {
                var db = new Mock<IAppDbContext>();
                db.Setup(x => x.LlmTraces).Throws(new InvalidOperationException("db down"));
                var services = new ServiceCollection();
                services.AddScoped(_ => db.Object);
                ServiceProvider = services.BuildServiceProvider();
            }
            public void Dispose() { }
        }
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
