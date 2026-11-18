using Application.Ai;
using Application.Auth;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.Exceptions;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// The daily LLM spend per feature: what a day's calls add up to, what a restart remembers, and the
/// one admin email when a budgeted feature crosses 80% of its day.
/// </summary>
public class RollingSpendTrackerTests
{
    private static readonly DateTimeOffset Day1 = new(2026, 6, 18, 10, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Day2 = new(2026, 6, 19, 10, 0, 0, TimeSpan.Zero);

    private readonly IEmailService _email = Substitute.For<IEmailService>();
    private readonly SteppedClock _clock = new() { Now = Day1 };
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void Record_ADaysCalls_SumToTheMicroDollar()
    {
        var t = Build();

        Assert.Equal(0m, t.SpentTodayUsd("never-touched"));
        t.Record("explain", 0.5m);
        t.Record("explain", 0.25m);
        Assert.Equal(0.75m, t.SpentTodayUsd("explain"));

        // 0.000001 USD = exactly 1 micro-dollar; 1000 of them = 0.001 USD, nothing lost to rounding.
        for (var i = 0; i < 1000; i++)
            t.Record("translate", 0.000001m);
        Assert.Equal(0.001m, t.SpentTodayUsd("translate"));
    }

    [Fact]
    public void Record_ThousandCallsAtOnce_SumExactly()
    {
        var t = Build();

        Parallel.For(0, 1000, _ => t.Record("explain", 0.001m));

        Assert.Equal(1.0m, t.SpentTodayUsd("explain"));
    }

    /// <summary>A restart seeds today's spend from the sampled traces (scaled by 1/rate) once; a failing database seeds 0.</summary>
    [Theory]
    [InlineData(0.1, false, "1.0")]   // 0.10 traced at a 10% sample → 1.00 estimated
    [InlineData(1.0, false, "0.1")]   // traced in full → unscaled
    [InlineData(0.1, true, "0")]    // database down → seed swallowed, starts at 0
    public void SpentTodayUsd_AfterARestart_SeedsTodaysSampledSpendOnce(double sampleRate, bool databaseDown, string seededUsd)
    {
        var seeded = decimal.Parse(seededUsd, System.Globalization.CultureInfo.InvariantCulture);
        var source = new FakeSpendSource(databaseDown ? null :
        [
            new("explain", 0.05m, Day1),
            new("explain", 0.05m, Day1),
            new("explain", 9m, Day1.AddDays(-1)), // yesterday's: not today's spend
        ]);
        var tracing = new TracingOptions(1.0, new Dictionary<string, double> { ["explain"] = sampleRate });
        var t = Build(source: source, tracing: tracing);

        Assert.Equal(seeded, t.SpentTodayUsd("explain"));
        t.Record("explain", 1.0m);
        Assert.Equal(seeded + 1.0m, t.SpentTodayUsd("explain")); // live records on top, seed not re-applied
        Assert.Equal(1, source.Calls);
    }

    [Fact]
    public void Record_SpendCrosses80Percent_AlertsTheAdminOncePerDay()
    {
        var t = Build(budgets: Budget("explain", daily: 10m, BudgetMode.HardStop));

        t.Record("translate", 1000m); // no budget → never alerts
        t.Record("explain", 7.0m);    // 70%: below the line
        _email.DidNotReceiveWithAnyArgs().SendAdminAlertAsync(default!, default!, Ct);

        t.Record("explain", 1.5m);    // crosses to 85%: the one alert
        for (var i = 0; i < 100; i++)
            t.Record("explain", 1.0m); // far over 80% and 100%: no storm
        _email.Received(1).SendAdminAlertAsync(Arg.Is<string>(s => s.Contains("'explain' at 85")), Arg.Any<string>(), Arg.Any<CancellationToken>());
        _email.ReceivedWithAnyArgs(1).SendAdminAlertAsync(default!, default!, Ct);

        _clock.Now = Day2; // a new UTC day: spend back to 0, alert armed again
        Assert.Equal(0m, t.SpentTodayUsd("explain"));
        t.Record("explain", 9.0m);
        Assert.Equal(9.0m, t.SpentTodayUsd("explain"));
        _email.ReceivedWithAnyArgs(2).SendAdminAlertAsync(default!, default!, Ct);
    }

    [Fact]
    public void Record_ManyCallsCrossAtOnce_OneAlert()
    {
        var t = Build(budgets: Budget("explain", 10m, BudgetMode.Fallback));

        Parallel.For(0, 200, _ => t.Record("explain", 0.1m)); // $20, well over 80%

        _email.ReceivedWithAnyArgs(1).SendAdminAlertAsync(default!, default!, Ct);
    }

    [Fact]
    public void Record_DefaultDispatch_SendsTheAlertOffTheRecordingThread()
    {
        // Production path: Record never waits for the email. The one test that polls.
        var t = Build(budgets: Budget("explain", 10m, BudgetMode.HardStop), inlineAlerts: false);

        t.Record("explain", 8.5m);

        Eventually(() => _email.ReceivedWithAnyArgs(1).SendAdminAlertAsync(default!, default!, Ct));
    }

    // ---- harness ----

    private static void Eventually(Action assert, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            try { assert(); return; }
            catch (ReceivedCallsException) when (DateTime.UtcNow < deadline) { Thread.Sleep(20); }
        }
    }

    private static BudgetOptions Budget(string feature, decimal daily, BudgetMode mode) =>
        new(new FeatureBudget(null, null, BudgetMode.Off),
            new Dictionary<string, FeatureBudget> { [feature] = new(daily, "ollama", mode) });

    private RollingSpendTracker Build(
        BudgetOptions? budgets = null, FakeSpendSource? source = null, TracingOptions? tracing = null, bool inlineAlerts = true) =>
        new(new ServiceCollection().AddScoped(_ => _email).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
            _clock,
            budgets ?? BudgetOptions.Empty,
            tracing ?? new TracingOptions(),
            NullLogger<RollingSpendTracker>.Instance,
            source ?? new FakeSpendSource([]))
        {
            // #1134: send the alert on the calling thread, so the tests assert right after
            // Record instead of polling for a Task.Run a starved thread pool may not start in time.
            Dispatch = inlineAlerts ? work => work() : work => Task.Run(work),
        };

    private sealed record TraceRow(string Feature, decimal CostUsd, DateTimeOffset At);

    /// <summary>The V2 traces' spend sum (V2LlmTraceWriter in production); <c>null</c> rows = a failing database.</summary>
    private sealed class FakeSpendSource(List<TraceRow>? traces) : ILlmSpendSource
    {
        private int _calls;
        public int Calls => Volatile.Read(ref _calls);

        public decimal SampledCostSince(string featureTag, DateTimeOffset since)
        {
            Interlocked.Increment(ref _calls);
            if (traces is null) throw new InvalidOperationException("db down");
            return traces.Where(t => t.Feature == featureTag && t.At >= since).Sum(t => t.CostUsd);
        }
    }
}
