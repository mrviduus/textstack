using Api.Services;
using Application.Auth;
using Domain.Entities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// DriftDetectionWorker.ProcessFeatureAsync flow coverage (Phase 12 RLOps slice 5b) over an
/// in-memory <see cref="FakeAppDbContext"/> + deterministic fake embedder (NO real OpenAI):
/// insufficient-sample path, baseline cold-start, and the synthetic-regression demo (a stable
/// baseline then off-distribution days that breach the threshold for 2 consecutive days → an
/// `alerting` row + exactly one admin email).
/// </summary>
public class DriftDetectionWorkerFlowTests
{
    private const string Feature = "explain";
    private static readonly DateOnly Day0 = new(2026, 6, 1);

    // Deterministic embedder: maps a text to a unit vector along one axis chosen by a tag prefix.
    // "A:" → axis 0, "B:" → axis 1. Lets a test place "today" near or far from the baseline.
    private sealed class FakeEmbedder : IEmbeddingService
    {
        public int Dimensions => 3;
        public Task<float[]> EmbedAsync(string text, CancellationToken ct)
        {
            var v = text.StartsWith("B:", StringComparison.Ordinal)
                ? new[] { 0f, 1f, 0f }
                : new[] { 1f, 0f, 0f };
            return Task.FromResult(v);
        }
        public Task<IReadOnlyList<float[]>> EmbedBatchAsync(IReadOnlyList<string> texts, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private sealed class CountingEmailService : IEmailService
    {
        public int AlertCount { get; private set; }
        public string? LastSubject { get; private set; }
        public Task SendPasswordResetEmailAsync(string toEmail, string token, CancellationToken ct) =>
            Task.CompletedTask;
        public Task SendAdminAlertAsync(string subject, string htmlBody, CancellationToken ct)
        {
            AlertCount++;
            LastSubject = subject;
            return Task.CompletedTask;
        }
    }

    // Minimal IServiceProvider: only IEmailService is resolvable (the only sp.GetRequiredService in
    // ProcessFeatureAsync — embedder + db are passed as args).
    private sealed class SingleServiceProvider(object svc) : IServiceProvider
    {
        public object? GetService(Type serviceType) =>
            serviceType.IsInstanceOfType(svc) ? svc : null;
    }

    private static IConfiguration DefaultConfig() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Drift:MaxSampleSize"] = "50",
            ["Drift:MinSampleSize"] = "10",
            ["Drift:Threshold"] = "0.15",
            ["Drift:ConsecutiveDays"] = "2",
            ["Drift:BaselineWindowDays"] = "7",
        }).Build();

    // ProcessFeatureAsync never touches the scope factory (only TickAsync does), so a throwing one is fine.
    private sealed class ThrowingScopeFactory : Microsoft.Extensions.DependencyInjection.IServiceScopeFactory
    {
        public Microsoft.Extensions.DependencyInjection.IServiceScope CreateScope() =>
            throw new NotSupportedException();
    }

    private static DriftDetectionWorker Worker(IConfiguration config) =>
        new(new ThrowingScopeFactory(), config, NullLogger<DriftDetectionWorker>.Instance);

    private static Domain.Entities.LlmTrace MakeTrace(string content, DateTimeOffset at) => new()
    {
        Id = Guid.NewGuid(),
        FeatureTag = Feature,
        ModelId = "gpt-4.1-nano",
        PromptHash = "h",
        MessagesJson = "[{\"Role\":\"user\",\"Content\":\"" + content + "\"}]",
        CreatedAt = at,
        Error = null,
    };

    [Fact]
    public async Task ProcessFeature_TooFewSamples_WritesInsufficientNoEmbed()
    {
        var db = new FakeAppDbContext();
        var now = Day0.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        // 5 traces < MinSampleSize(10).
        for (var i = 0; i < 5; i++)
            db.TraceStore.Add(MakeTrace("A:hello", now.AddMinutes(-i)));

        var email = new CountingEmailService();
        var worker = Worker(DefaultConfig());

        await worker.ProcessFeatureAsync(
            new SingleServiceProvider(email), db, new FakeEmbedder(), Feature,
            Day0, now, CancellationToken.None);

        var row = Assert.Single(db.DriftStore);
        Assert.Equal("insufficient", row.AlertState);
        Assert.Null(row.DriftScore);
        Assert.Null(row.Centroid);
        Assert.Equal(5, row.SampleSize);
        Assert.Equal(0, email.AlertCount);
    }

    [Fact]
    public async Task ProcessFeature_NoPriors_SeedsBaselineRowZeroDrift()
    {
        var db = new FakeAppDbContext();
        var now = Day0.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("A:hello", now.AddMinutes(-i)));

        var email = new CountingEmailService();
        var worker = Worker(DefaultConfig());

        await worker.ProcessFeatureAsync(
            new SingleServiceProvider(email), db, new FakeEmbedder(), Feature,
            Day0, now, CancellationToken.None);

        var row = Assert.Single(db.DriftStore);
        Assert.Equal("baseline", row.AlertState);
        Assert.Equal(0d, row.DriftScore);
        Assert.NotNull(row.Centroid);
        Assert.Equal(0, email.AlertCount);
    }

    [Fact]
    public async Task ProcessFeature_AlreadyHasTodayRow_NoOp()
    {
        var db = new FakeAppDbContext();
        var now = Day0.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        db.DriftStore.Add(new DriftCentroid
        {
            Id = Guid.NewGuid(),
            Feature = Feature,
            Day = Day0,
            AlertState = "ok",
            SampleSize = 12,
            CreatedAt = now,
        });
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("A:hello", now.AddMinutes(-i)));

        var worker = Worker(DefaultConfig());
        // Throwing embedder proves the idempotency skip bails BEFORE any embedding work/cost — if the
        // AnyAsync(today) short-circuit regressed, EmbedAsync would throw and fail the test.
        await worker.ProcessFeatureAsync(
            new SingleServiceProvider(new CountingEmailService()), db, new ThrowingEmbedder(), Feature,
            Day0, now, CancellationToken.None);

        // Idempotent: still exactly the one pre-existing row, no new SaveChanges.
        Assert.Single(db.DriftStore);
        Assert.Equal(0, db.SaveCalls);
    }

    [Fact]
    public async Task ProcessFeature_SyntheticRegression_TwoOffDistributionDays_AlertsOnce()
    {
        var db = new FakeAppDbContext();
        var email = new CountingEmailService();
        var worker = Worker(DefaultConfig());
        var sp = new SingleServiceProvider(email);
        var embedder = new FakeEmbedder();

        // Seed a stable baseline: 5 prior days all on axis 0 ("A:"), drift 0.
        for (var d = 0; d < 5; d++)
        {
            var day = Day0.AddDays(d);
            var at = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
            db.TraceStore.Clear();
            for (var i = 0; i < 12; i++)
                db.TraceStore.Add(MakeTrace("A:stable", at.AddMinutes(-i)));
            await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day, at, CancellationToken.None);
        }

        Assert.Equal(0, email.AlertCount); // stable baseline never alerts
        Assert.All(db.DriftStore, r => Assert.True(r.AlertState is "baseline" or "ok"));

        // Day 5: off-distribution (axis 1, "B:") → drift ≈ 1.0 ≥ 0.15 → first breach → warning.
        var day5 = Day0.AddDays(5);
        var at5 = day5.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        db.TraceStore.Clear();
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("B:shifted", at5.AddMinutes(-i)));
        await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day5, at5, CancellationToken.None);

        var row5 = db.DriftStore.Single(r => r.Day == day5);
        Assert.Equal("warning", row5.AlertState);
        Assert.True(row5.DriftScore >= 0.15);
        Assert.Equal(1, row5.ConsecutiveBreaches);
        Assert.Equal(0, email.AlertCount); // not yet 2 consecutive

        // Day 6: still off-distribution → 2nd consecutive breach → alerting + exactly one email.
        var day6 = Day0.AddDays(6);
        var at6 = day6.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        db.TraceStore.Clear();
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("B:shifted", at6.AddMinutes(-i)));
        await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day6, at6, CancellationToken.None);

        var row6 = db.DriftStore.Single(r => r.Day == day6);
        Assert.Equal("alerting", row6.AlertState);
        Assert.Equal(2, row6.ConsecutiveBreaches);
        Assert.NotNull(row6.AlertedAt);
        Assert.Equal(1, email.AlertCount);
        Assert.Contains(Feature, email.LastSubject);

        // Day 7: still breaching → stays alerting but NO second email (debounced per streak).
        var day7 = Day0.AddDays(7);
        var at7 = day7.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        db.TraceStore.Clear();
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("B:shifted", at7.AddMinutes(-i)));
        await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day7, at7, CancellationToken.None);

        var row7 = db.DriftStore.Single(r => r.Day == day7);
        Assert.Equal("alerting", row7.AlertState);
        Assert.Equal(3, row7.ConsecutiveBreaches);
        Assert.Equal(1, email.AlertCount); // still 1 — no re-alert
    }

    // Re-arm after a reset: a sustained streak alerts once, a non-breaching day resets it, then a
    // NEW streak must alert AGAIN. Attacks invariant 5's "re-arms after reset+new streak" clause
    // end-to-end (the unit Decide test covers the math; this drives the worker's prior-row read).
    [Fact]
    public async Task ProcessFeature_StreakResetThenNewStreak_AlertsTwice()
    {
        var db = new FakeAppDbContext();
        var email = new CountingEmailService();
        var worker = Worker(DefaultConfig());
        var sp = new SingleServiceProvider(email);
        var embedder = new FakeEmbedder();

        async Task RunDay(DateOnly day, string tag)
        {
            var at = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
            db.TraceStore.Clear();
            for (var i = 0; i < 12; i++)
                db.TraceStore.Add(MakeTrace(tag, at.AddMinutes(-i)));
            await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day, at, CancellationToken.None);
        }

        // Day 0: baseline on axis 0.
        await RunDay(Day0, "A:stable");
        // Days 1-2: off-distribution (axis 1) → 2 consecutive breaches → ALERT #1 on day 2.
        await RunDay(Day0.AddDays(1), "B:shifted");
        await RunDay(Day0.AddDays(2), "B:shifted");
        Assert.Equal(1, email.AlertCount);
        Assert.Equal("alerting", db.DriftStore.Single(r => r.Day == Day0.AddDays(2)).AlertState);

        // Day 3: back on-distribution → drift ~0 → reset to ok, streak cleared, alert re-armed.
        await RunDay(Day0.AddDays(3), "A:stable");
        var resetRow = db.DriftStore.Single(r => r.Day == Day0.AddDays(3));
        Assert.Equal("ok", resetRow.AlertState);
        Assert.Equal(0, resetRow.ConsecutiveBreaches);
        Assert.Equal(1, email.AlertCount); // no new alert on reset

        // Days 4-5: off-distribution AGAIN → 2 consecutive breaches → ALERT #2 (re-armed).
        await RunDay(Day0.AddDays(4), "B:shifted");
        Assert.Equal(1, email.AlertCount); // day 4 is only the 1st breach of the new streak
        await RunDay(Day0.AddDays(5), "B:shifted");
        var alertRow2 = db.DriftStore.Single(r => r.Day == Day0.AddDays(5));
        Assert.Equal("alerting", alertRow2.AlertState);
        Assert.Equal(2, alertRow2.ConsecutiveBreaches);
        Assert.Equal(2, email.AlertCount); // re-armed → fired a 2nd time
    }

    // Sustained drift longer than the baseline window must NOT silently re-baseline to drift 0:
    // because breaching days are excluded from the baseline, Take(window) reaches back to the last
    // good day before the drift, so every drifted day keeps comparing against the known-good baseline
    // and stays `alerting` (one email, never reset). Guards the fix for baseline self-poisoning.
    [Fact]
    public async Task ProcessFeature_DriftLongerThanBaselineWindow_StaysAlertingOneEmail()
    {
        var db = new FakeAppDbContext();
        var email = new CountingEmailService();
        var worker = Worker(DefaultConfig()); // BaselineWindowDays = 7
        var sp = new SingleServiceProvider(email);
        var embedder = new FakeEmbedder();

        async Task RunDay(DateOnly day, string tag)
        {
            var at = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
            db.TraceStore.Clear();
            for (var i = 0; i < 12; i++)
                db.TraceStore.Add(MakeTrace(tag, at.AddMinutes(-i)));
            await worker.ProcessFeatureAsync(sp, db, embedder, Feature, day, at, CancellationToken.None);
        }

        // 1 baseline day, then 10 straight off-distribution days (> 7-day window).
        await RunDay(Day0, "A:stable");
        for (var d = 1; d <= 10; d++)
            await RunDay(Day0.AddDays(d), "B:shifted");

        // Every drifted day still breaches against the preserved good baseline.
        for (var d = 2; d <= 10; d++)
        {
            var row = db.DriftStore.Single(r => r.Day == Day0.AddDays(d));
            Assert.Equal("alerting", row.AlertState);
            Assert.True(row.DriftScore >= 0.15, $"day {d} drift {row.DriftScore} should breach");
        }
        Assert.Equal(1, email.AlertCount); // exactly one email for the whole sustained streak
    }

    // Never-crash: a throwing embedder inside ProcessFeatureAsync surfaces as an exception — the
    // TickAsync per-feature catch (covered structurally) swallows it. Here we assert the throw is the
    // ONLY failure mode (no partial/corrupt row is persisted) so a later retry is clean/idempotent.
    [Fact]
    public async Task ProcessFeature_EmbedderThrows_NoPartialRowPersisted()
    {
        var db = new FakeAppDbContext();
        var now = Day0.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        for (var i = 0; i < 12; i++)
            db.TraceStore.Add(MakeTrace("A:hello", now.AddMinutes(-i)));

        var worker = Worker(DefaultConfig());

        await Assert.ThrowsAnyAsync<Exception>(() => worker.ProcessFeatureAsync(
            new SingleServiceProvider(new CountingEmailService()), db, new ThrowingEmbedder(), Feature,
            Day0, now, CancellationToken.None));

        // Embedding happens before any Add — nothing should have been written for today.
        Assert.Empty(db.DriftStore);
        Assert.Equal(0, db.SaveCalls);
    }

    private sealed class ThrowingEmbedder : IEmbeddingService
    {
        public int Dimensions => 3;
        public Task<float[]> EmbedAsync(string text, CancellationToken ct) =>
            throw new InvalidOperationException("embedding backend down");
        public Task<IReadOnlyList<float[]>> EmbedBatchAsync(IReadOnlyList<string> texts, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
