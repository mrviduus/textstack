using System.Data.Common;
using System.Text.Json;
using Application.Ai;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Core;

namespace Api.Services;

/// <summary>
/// Phase 12 RLOps slice 5b: embedding-drift detection. Periodically (default daily) samples a
/// feature's recent <c>llm_traces</c> prompts, embeds them into a daily centroid (mean-pooled),
/// measures cosine drift against the rolling baseline of prior daily centroids, and emails an
/// admin alert after N consecutive breaches. Persists one <c>drift_centroids</c> row per
/// (feature, day) — the unique index makes a same-day re-run idempotent and doubles as the
/// "is it due?" probe.
///
/// OFF by default (<c>Drift:Enabled=false</c>) — it spends embedding $ when enabled. The bounded
/// daily sample (<c>Drift:MaxSampleSize</c>) is the cost control. Mirrors
/// <see cref="ContinuousEvalWorker"/>: Api-host BackgroundService, ~10min startup delay, hourly
/// check, its OWN Postgres advisory lock (multi-replica safe), never crashes the host (every tick
/// wrapped; the lock is released under <see cref="CancellationToken.None"/> so shutdown can't leak it).
/// </summary>
public sealed class DriftDetectionWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<DriftDetectionWorker> logger) : BackgroundService
{
    // Fixed advisory-lock key — DIFFERENT from ContinuousEvalWorker's so the two workers never
    // contend with each other; all replicas contend on this one key for the drift sweep.
    private const long AdvisoryLockKey = 0x7E5C_0D11_FL; // "TeSC DrIF"-ish marker

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Drift detection worker started");

        // Startup delay so a cold boot doesn't immediately fire embeddings (mirror other workers).
        try { await Task.Delay(TimeSpan.FromMinutes(10), stoppingToken); }
        catch (OperationCanceledException) { return; }

        var checkHours = Math.Max(config.GetValue("Drift:CheckIntervalHours", 1), 1);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(checkHours));

        do
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Drift detection tick failed");
            }
        }
        while (await ContinuousEvalWorker.WaitNextAsync(timer, stoppingToken));
    }

    // internal (not private) so a unit test can drive a single tick and prove the disabled
    // short-circuit does zero DB/scope/lock work.
    internal async Task TickAsync(CancellationToken ct)
    {
        if (!config.GetValue("Drift:Enabled", false))
            return;

        using var scope = scopeFactory.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();

        var features = config.GetSection("Drift:Features").Get<string[]>() ?? ["explain"];
        if (features.Length == 0)
            return;

        DbConnection? conn = null;
        var advisoryHeld = false;
        try
        {
            // Cross-replica guard: only one replica runs the drift sweep per tick.
            conn = await ContinuousEvalWorker.OpenConnectionAsync(db, ct);
            advisoryHeld = await ContinuousEvalWorker.TryAdvisoryLockAsync(conn, AdvisoryLockKey, ct);
            if (!advisoryHeld)
            {
                logger.LogInformation("Drift sweep skipped: advisory lock held by another replica");
                return;
            }

            var embedder = sp.GetRequiredService<IEmbeddingService>();
            var today = DateOnly.FromDateTime(DateTime.UtcNow);

            foreach (var feature in features)
            {
                // Per-feature isolation: one feature's failure must not skip the others.
                try
                {
                    await ProcessFeatureAsync(sp, db, embedder, feature, today, DateTimeOffset.UtcNow, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Drift detection failed for feature {Feature}", feature);
                }
            }
        }
        finally
        {
            // Release the session-level advisory lock on the SAME connection that took it. Use
            // CancellationToken.None (NOT the tick token, which may be cancelled on shutdown) so the
            // unlock SQL always runs — otherwise the lock leaks onto the pooled connection.
            if (advisoryHeld && conn is not null)
                await ContinuousEvalWorker.UnlockAsync(conn, AdvisoryLockKey);
        }
    }

    /// <summary>
    /// Compute + persist one feature's drift row for <paramref name="today"/> (UTC). Idempotent:
    /// returns immediately if a row already exists for (feature, today). Public so an integration
    /// test can drive it directly with a fake embedder instead of the full timer.
    /// </summary>
    public async Task ProcessFeatureAsync(
        IServiceProvider sp,
        IAppDbContext db,
        IEmbeddingService embedder,
        string feature,
        DateOnly today,
        DateTimeOffset now,
        CancellationToken ct)
    {
        // Idempotency: skip features that already have today's row (also the "is it due?" check).
        var alreadyToday = await db.DriftCentroids
            .AnyAsync(d => d.Feature == feature && d.Day == today, ct);
        if (alreadyToday)
            return;

        var maxSample = Math.Max(1, config.GetValue("Drift:MaxSampleSize", 50));
        var minSample = Math.Max(1, config.GetValue("Drift:MinSampleSize", 10));
        var threshold = config.GetValue("Drift:Threshold", 0.15);
        var consecutiveDays = Math.Max(1, config.GetValue("Drift:ConsecutiveDays", 2));
        var baselineWindow = Math.Max(1, config.GetValue("Drift:BaselineWindowDays", 7));

        // 1. Sample: newest successful traces in the last 24h for this feature.
        var since = now - TimeSpan.FromHours(24);
        var rawMessages = await db.LlmTraces
            .Where(t => t.FeatureTag == feature && t.CreatedAt >= since && t.Error == null)
            .OrderByDescending(t => t.CreatedAt)
            .Take(maxSample)
            .Select(t => t.MessagesJson)
            .ToListAsync(ct);

        var prompts = rawMessages
            .Select(FirstUserMessage)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s!)
            .ToList();

        if (prompts.Count < minSample)
        {
            // Too few samples to trust a centroid — record an `insufficient` row and skip the math.
            db.DriftCentroids.Add(new DriftCentroid
            {
                Id = Guid.NewGuid(),
                Feature = feature,
                Day = today,
                Centroid = null,
                SampleSize = prompts.Count,
                DriftScore = null,
                ConsecutiveBreaches = 0,
                AlertState = "insufficient",
                CreatedAt = now,
            });
            await db.SaveChangesAsync(ct);
            logger.LogInformation(
                "Drift {Feature}: insufficient sample ({Count} < {Min})", feature, prompts.Count, minSample);
            return;
        }

        // 2. Embed each sampled prompt → today's centroid.
        var vectors = new List<float[]>(prompts.Count);
        foreach (var p in prompts)
            vectors.Add(await embedder.EmbedAsync(p, ct));
        var todayCentroid = DriftCalculator.MeanPool(vectors);

        // 3. Baseline = mean-pool of the N most-recent KNOWN-GOOD prior daily centroids (EXCLUDING
        //    today; only rows with a centroid; EXCLUDING breaching `warning`/`alerting` days). The
        //    `Take(N)` is applied AFTER filtering out breaching days, so it reaches back PAST a drift
        //    to the last good days — a sustained drift never poisons or re-seeds its own baseline, and
        //    the streak can still reset (so the spec's "re-arm after reset" is reachable). No good
        //    prior at all (true cold start) → seed a `baseline` row (drift 0, never alerts).
        var priorCentroids = await db.DriftCentroids
            .Where(d => d.Feature == feature
                && d.Day < today
                && d.Centroid != null
                && d.AlertState != "warning"
                && d.AlertState != "alerting")
            .OrderByDescending(d => d.Day)
            .Take(baselineWindow)
            .Select(d => d.Centroid!)
            .ToListAsync(ct);

        if (priorCentroids.Count == 0)
        {
            db.DriftCentroids.Add(new DriftCentroid
            {
                Id = Guid.NewGuid(),
                Feature = feature,
                Day = today,
                Centroid = todayCentroid,
                SampleSize = prompts.Count,
                DriftScore = 0,
                ConsecutiveBreaches = 0,
                AlertState = "baseline",
                CreatedAt = now,
            });
            await db.SaveChangesAsync(ct);
            logger.LogInformation("Drift {Feature}: baseline seeded ({Count} samples)", feature, prompts.Count);
            return;
        }

        var baseline = DriftCalculator.MeanPool(priorCentroids);
        var driftScore = DriftCalculator.CosineDrift(todayCentroid, baseline);

        // 4. Load the prior row's streak state and run the state machine.
        var priorRow = await db.DriftCentroids
            .Where(d => d.Feature == feature && d.Day < today)
            .OrderByDescending(d => d.Day)
            .Select(d => new { d.ConsecutiveBreaches, d.AlertState })
            .FirstOrDefaultAsync(ct);

        var priorBreaches = priorRow?.ConsecutiveBreaches ?? 0;
        var alreadyAlerted = priorRow?.AlertState == "alerting";

        var decision = DriftCalculator.Decide(
            priorBreaches, driftScore, threshold, consecutiveDays, alreadyAlerted);

        var row = new DriftCentroid
        {
            Id = Guid.NewGuid(),
            Feature = feature,
            Day = today,
            Centroid = todayCentroid,
            SampleSize = prompts.Count,
            DriftScore = driftScore,
            ConsecutiveBreaches = decision.ConsecutiveBreaches,
            AlertState = decision.AlertState,
            AlertedAt = decision.ShouldAlert ? now : null,
            CreatedAt = now,
        };
        db.DriftCentroids.Add(row);
        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "Drift {Feature}: score {Score:F4} state {State} breaches {Breaches}",
            feature, driftScore, decision.AlertState, decision.ConsecutiveBreaches);

        // 5. Fire-and-forget alert on the moment a streak first reaches alerting. Swallow+log.
        if (decision.ShouldAlert)
        {
            try
            {
                var email = sp.GetRequiredService<IEmailService>();
                var subject = $"[TextStack] AI input drift: {feature} (drift {driftScore:0.000})";
                var body =
                    $"<p>Embedding drift detected for feature <b>{feature}</b>.</p>"
                    + $"<ul><li>Drift score: {driftScore:0.000} (threshold {threshold:0.000})</li>"
                    + $"<li>Consecutive breaching days: {decision.ConsecutiveBreaches}</li>"
                    + $"<li>Sample size: {prompts.Count}</li></ul>"
                    + "<p>Input distribution has shifted from the rolling baseline — review the feature's recent prompts.</p>";
                await email.SendAdminAlertAsync(subject, body, ct);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to send drift alert for feature {Feature}", feature);
            }
        }
    }

    /// <summary>Extracts the first <c>"user"</c> message's Content from a serialized
    /// <c>LlmMessage[]</c> (the <c>llm_traces.MessagesJson</c> shape). Null if absent/unparseable —
    /// a malformed trace is skipped, not fatal.</summary>
    internal static string? FirstUserMessage(string messagesJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(messagesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return null;

            foreach (var msg in doc.RootElement.EnumerateArray())
            {
                if (msg.ValueKind != JsonValueKind.Object)
                    continue;
                if (msg.TryGetProperty("Role", out var role)
                    && role.ValueKind == JsonValueKind.String
                    && string.Equals(role.GetString(), "user", StringComparison.OrdinalIgnoreCase)
                    && msg.TryGetProperty("Content", out var content)
                    && content.ValueKind == JsonValueKind.String)
                {
                    return content.GetString();
                }
            }
        }
        catch (JsonException)
        {
            // Malformed trace — skip it.
        }
        return null;
    }
}
