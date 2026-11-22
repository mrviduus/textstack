using System.Collections.Concurrent;
using Application.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace Application.Ai;

/// <summary>
/// In-memory, process-local per-feature daily (UTC) spend tracker (Phase 12 RLOps slice 4).
/// Backs the ModelGateway's cost-aware routing + per-feature daily budget. Singleton.
///
/// Storage is a lock-free <see cref="ConcurrentDictionary{TKey,TValue}"/> of feature → a bucket
/// holding the UTC day + the day's spend as <b>long micro-dollars</b> (cost × 1e6, rounded), so
/// increments are a single <see cref="Interlocked.Add(ref long, long)"/> with no decimal contention.
///
/// Day rollover: both <see cref="Record"/> and <see cref="SpentTodayUsd"/> compare the bucket's UTC
/// date (via the injected <see cref="TimeProvider"/>) to today; a stale bucket is atomically swapped
/// for a fresh zeroed one before use, so a new day starts at 0.
///
/// Lazy seed: the FIRST touch of a (feature, today) bucket queries <c>llm_traces</c> for today's
/// summed cost (<see cref="ILlmSpendSource"/>) and scales it by <c>1/sampleRate</c> for that feature (traces are
/// sampled — e.g. explain at 0.1 → multiply by 10). This APPROXIMATELY recovers spend accrued before
/// a process restart; it is an estimate, not exact (sampling variance + the in-flight window between
/// the seed query and the first post-restart Record). Runs at most once per bucket and never throws.
///
/// 80% alert: when an increment pushes a budgeted feature from below to ≥ 80% of its daily budget,
/// one admin alert email is fired (fire-and-forget, deduped per (feature, day)). All side effects are
/// wrapped in try/catch — this lives on the LLM hot path and the fire-and-forget completion path, so
/// it NEVER throws: <see cref="SpentTodayUsd"/> fails open to 0.
/// </summary>
public sealed class RollingSpendTracker(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    BudgetOptions budgets,
    TracingOptions tracing,
    ILogger<RollingSpendTracker> logger,
    ILlmSpendSource? spendSource = null) : ISpendTracker
{
    private const decimal MicrosPerDollar = 1_000_000m;

    private sealed class Bucket(DateOnly utc)
    {
        public DateOnly Utc { get; } = utc;
        public long Micros;
        public int Seeded; // 0 = not yet seeded; set to 1 via Interlocked.Exchange.
    }

    // Runs the fire-and-forget alert send. Tests run it inline (#1134): under a 200-way
    // Parallel.For on a loaded runner, Task.Run could start the send after the test gave up.
    internal Func<Func<Task>, Task> Dispatch { get; init; } = work => Task.Run(work);

    private readonly ConcurrentDictionary<string, Bucket> _buckets = new();
    // Dedup key for the 80%-budget alert: at most one alert per (feature, UTC day).
    private readonly ConcurrentDictionary<(string Feature, DateOnly Day), bool> _alerted = new();

    public decimal SpentTodayUsd(string featureTag)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(featureTag))
                return 0m;
            var bucket = GetTodayBucket(featureTag);
            return Interlocked.Read(ref bucket.Micros) / MicrosPerDollar;
        }
        catch (Exception ex)
        {
            // Fail open: a tracker glitch must never block a paid feature.
            logger.LogDebug(ex, "SpentTodayUsd failed for feature '{Feature}'; treating as 0", featureTag);
            return 0m;
        }
    }

    public void Record(string featureTag, decimal costUsd)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(featureTag) || costUsd <= 0m)
                return;

            var bucket = GetTodayBucket(featureTag);
            var micros = (long)Math.Round(costUsd * MicrosPerDollar, MidpointRounding.AwayFromZero);
            if (micros <= 0)
                return;

            var before = Interlocked.Read(ref bucket.Micros);
            var after = Interlocked.Add(ref bucket.Micros, micros);

            MaybeAlert(featureTag, bucket.Utc, before, after);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Record failed for feature '{Feature}'", featureTag);
        }
    }

    /// <summary>Fetch the bucket for (feature, today), rolling a stale day over to a fresh zeroed
    /// bucket and lazily seeding it from llm_traces exactly once.</summary>
    private Bucket GetTodayBucket(string featureTag)
    {
        var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);

        var bucket = _buckets.AddOrUpdate(
            featureTag,
            _ => new Bucket(today),
            (_, existing) => existing.Utc == today ? existing : new Bucket(today));

        // Seed at most once per bucket (the very first touch of a (feature, today) pair).
        if (Interlocked.Exchange(ref bucket.Seeded, 1) == 0)
            SeedFromTraces(featureTag, bucket);

        return bucket;
    }

    /// <summary>Query today's summed trace cost and scale by 1/sampleRate to estimate true spend
    /// (traces are sampled). Best-effort: any failure leaves the bucket at its current value.</summary>
    private void SeedFromTraces(string featureTag, Bucket bucket)
    {
        try
        {
            var utcMidnight = new DateTimeOffset(bucket.Utc.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero);

            var sampledCost = spendSource?.SampledCostSince(featureTag, utcMidnight) ?? 0m;

            if (sampledCost <= 0m)
                return;

            // Scale up by 1/sampleRate (sampled traces under-count). Guard a 0/negative/insane rate.
            var rate = tracing.RateFor(featureTag);
            if (rate <= 0d || rate > 1d)
                rate = 1d;
            var estimated = sampledCost / (decimal)rate;

            var micros = (long)Math.Round(estimated * MicrosPerDollar, MidpointRounding.AwayFromZero);
            if (micros > 0)
                Interlocked.Add(ref bucket.Micros, micros);
        }
        catch (Exception ex)
        {
            // Seed is an approximation; if it fails the bucket simply starts from live Records.
            logger.LogDebug(ex, "Spend seed from traces failed for feature '{Feature}'", featureTag);
        }
    }

    /// <summary>If this increment pushed a budgeted feature across the 80% line (and we haven't
    /// alerted yet today), fire one admin alert email. Fully best-effort.</summary>
    private void MaybeAlert(string featureTag, DateOnly day, long beforeMicros, long afterMicros)
    {
        try
        {
            if (budgets.ModeFor(featureTag) == BudgetMode.Off)
                return;
            if (budgets.DailyUsdFor(featureTag) is not { } dailyUsd)
                return;

            var thresholdMicros = (long)Math.Round(0.8m * dailyUsd * MicrosPerDollar, MidpointRounding.AwayFromZero);
            // Only on the crossing edge: was below, now at/above.
            if (beforeMicros >= thresholdMicros || afterMicros < thresholdMicros)
                return;

            // Dedup: one alert per (feature, day).
            if (!_alerted.TryAdd((featureTag, day), true))
                return;

            var spent = afterMicros / MicrosPerDollar;
            FireAlert(featureTag, dailyUsd, spent);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Budget alert check failed for feature '{Feature}'", featureTag);
        }
    }

    private void FireAlert(string featureTag, decimal dailyUsd, decimal spentUsd)
    {
        var pct = dailyUsd > 0m ? Math.Round(spentUsd / dailyUsd * 100m, 1) : 0m;
        var subject = $"[TextStack AI] '{featureTag}' at {pct}% of daily budget";
        var html =
            $"<p>Feature <b>{featureTag}</b> has spent <b>${spentUsd:0.######}</b> of its " +
            $"<b>${dailyUsd:0.######}</b> daily LLM budget ({pct}%).</p>" +
            "<p>At 100% the feature's budget mode takes effect (fallback or hard-stop).</p>";

        _ = Dispatch(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var email = scope.ServiceProvider.GetRequiredService<IEmailService>();
                await email.SendAdminAlertAsync(subject, html, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to send 80% budget alert for feature '{Feature}'", featureTag);
            }
        });
    }
}

/// <summary>
/// Where <see cref="RollingSpendTracker"/> seeds today's spend from (V2's <c>llm_traces</c>): the summed,
/// sampled <c>cost_usd</c> of a feature's traces since a moment. Absent, nothing is seeded. May throw; the
/// seed swallows it.
/// </summary>
public interface ILlmSpendSource
{
    decimal SampledCostSince(string featureTag, DateTimeOffset since);
}
