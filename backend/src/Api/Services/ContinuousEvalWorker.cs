using System.Data.Common;
using Application.Ai;
using Application.Auth;
using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;

namespace Api.Services;

/// <summary>
/// Phase 12 RLOps slice 5a: scheduled continuous evals. Periodically (default daily) re-runs
/// the SAME <see cref="EvalSuiteRunner"/> the admin Evals tab uses, persists with
/// <c>RunType="scheduled"</c>, then compares against the prior scheduled run and emails an admin
/// alert on any regression. OFF by default (<c>Eval:Scheduled:Enabled=false</c>) — it spends judge
/// $ when enabled. Multi-replica-safe via a Postgres advisory lock; in-process-safe via
/// <see cref="IEvalRunGate"/>; cost-capped via <see cref="ISpendTracker"/>. A failure logs + the
/// worker keeps looping — it never crashes the host.
/// </summary>
public sealed class ContinuousEvalWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    IEvalRunGate gate,
    EvalRegressionDetector regressionDetector,
    ILogger<ContinuousEvalWorker> logger) : BackgroundService
{
    // Fixed advisory-lock key (arbitrary but stable) — all replicas contend on the same key so
    // only one runs the scheduled eval per tick.
    private const long AdvisoryLockKey = 0x7E5C_0E5A_1L; // "TeSC EvAl"-ish marker

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Continuous eval worker started");

        // Startup delay so a cold boot doesn't immediately fire an eval (mirror other workers).
        try { await Task.Delay(TimeSpan.FromMinutes(10), stoppingToken); }
        catch (OperationCanceledException) { return; }

        var checkHours = Math.Max(config.GetValue("Eval:Scheduled:CheckIntervalHours", 1), 1);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(checkHours));

        do
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Continuous eval tick failed");
            }
        }
        while (await WaitNextAsync(timer, stoppingToken));
    }

    internal static async Task<bool> WaitNextAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

    // internal (not private) so a unit test can drive a single tick: prove the disabled
    // short-circuit does zero DB/scope/gate work, and that the loop's catch survives a throw.
    internal async Task TickAsync(CancellationToken ct)
    {
        if (!config.GetValue("Eval:Scheduled:Enabled", false))
            return;

        using var scope = scopeFactory.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();

        // "Is it due?" — no scheduled row newer than (now − IntervalHours).
        var intervalHours = Math.Max(config.GetValue("Eval:Scheduled:IntervalHours", 24), 1);
        var now = DateTimeOffset.UtcNow;
        var lastScheduledAt = await db.EvalRuns
            .Where(r => r.RunType == "scheduled")
            .OrderByDescending(r => r.CreatedAt)
            .Select(r => (DateTimeOffset?)r.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (!IsDue(lastScheduledAt, now, intervalHours))
            return;

        // Cost safety: skip if today's judge spend already exceeds the cap (0 = no cap). Fail-open.
        var budget = config.GetValue("Eval:Scheduled:DailyBudgetUsd", 0m);
        if (budget > 0m)
        {
            decimal spent;
            try { spent = sp.GetRequiredService<ISpendTracker>().SpentTodayUsd("eval.judge"); }
            catch { spent = 0m; } // fail-open: a tracker glitch must not block the scheduled run
            if (spent > budget)
            {
                logger.LogInformation(
                    "Scheduled eval skipped: judge spend ${Spent} > cap ${Budget}", spent, budget);
                return;
            }
        }

        // In-process overlap guard (shared with the admin trigger).
        if (!gate.TryEnter())
        {
            logger.LogInformation("Scheduled eval skipped: another eval run is in progress");
            return;
        }

        DbConnection? conn = null;
        var advisoryHeld = false;
        try
        {
            // Cross-replica guard: only one replica runs the scheduled eval per due-window.
            conn = await OpenConnectionAsync(db, ct);
            advisoryHeld = await TryAdvisoryLockAsync(conn, AdvisoryLockKey, ct);
            if (!advisoryHeld)
            {
                logger.LogInformation("Scheduled eval skipped: advisory lock held by another replica");
                return;
            }

            await RunAndAlertAsync(sp, db, ct);
        }
        finally
        {
            // Release the session-level advisory lock on the SAME connection that took it. Use
            // CancellationToken.None, NOT the (possibly already-cancelled on shutdown) tick token —
            // otherwise the unlock SQL is skipped and the lock leaks onto a pooled connection,
            // poisoning it for later requests until the session is physically dropped.
            if (advisoryHeld && conn is not null)
                await UnlockAsync(conn, AdvisoryLockKey);
            gate.Exit();
        }
    }

    /// <summary>Pure due-check: a scheduled run is due when there's no prior scheduled run, or
    /// the last one is at least <paramref name="intervalHours"/> old. Extracted for unit testing.</summary>
    public static bool IsDue(DateTimeOffset? lastScheduledAt, DateTimeOffset now, int intervalHours)
    {
        if (lastScheduledAt is not { } last)
            return true;
        return now - last >= TimeSpan.FromHours(intervalHours);
    }

    private async Task RunAndAlertAsync(IServiceProvider sp, IAppDbContext db, CancellationToken ct)
    {
        var features = config.GetSection("Eval:Scheduled:Features").Get<string[]>() ?? ["explain"];
        var judgeModelId = config["Eval:JudgeModel"] ?? "gpt-4.1";

        // Snapshot prior scheduled scores BEFORE the new run is written.
        var prior = await LoadLatestScheduledScoresAsync(db, features, ct);

        var runner = sp.GetRequiredService<EvalSuiteRunner>();
        var gateway = sp.GetRequiredService<ILlmService>();
        var judge = sp.GetRequiredKeyedService<ILlmService>("openai-judge");
        var gitSha = Environment.GetEnvironmentVariable("GIT_SHA");

        var results = await runner.RunAsync(
            _ => gateway, judge, judgeModelId, features, persist: true, db, gitSha, ct, runType: "scheduled");

        logger.LogInformation("Scheduled eval completed: {Count} feature(s)", results.Count);

        var current = results
            .Select(r => (r.Feature, r.ModelId, (double)Math.Round((decimal)r.Summary.MeanOverall, 3)))
            .ToList();

        var drop = config.GetValue("Eval:Scheduled:RegressionDrop", 0.5);
        var regressions = regressionDetector.Detect(prior, current, drop);
        if (regressions.Count == 0)
            return;

        // Fire-and-forget alert; swallow+log so an email hiccup never affects the run.
        try
        {
            var email = sp.GetRequiredService<IEmailService>();
            var lines = string.Join(", ", regressions.Select(r =>
                $"{r.Feature} ({r.ModelId}) {r.PriorScore:0.00}→{r.CurrentScore:0.00}, −{r.Drop:0.00}"));
            var subject = $"[TextStack] Scheduled eval regression: {lines}";
            var body = "<p>The scheduled eval run flagged a quality regression:</p><ul>"
                + string.Join("", regressions.Select(r =>
                    $"<li><b>{r.Feature}</b> ({r.ModelId}): {r.PriorScore:0.00} → {r.CurrentScore:0.00} "
                    + $"(drop {r.Drop:0.00})</li>"))
                + "</ul>";
            await email.SendAdminAlertAsync(subject, body, ct);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to send scheduled-eval regression alert");
        }
    }

    /// <summary>Latest scheduled per-(feature, model) score, for the regression baseline.</summary>
    private static async Task<List<(string Feature, string ModelId, double Score)>> LoadLatestScheduledScoresAsync(
        IAppDbContext db, IEnumerable<string> features, CancellationToken ct)
    {
        var featureSet = features.ToHashSet();
        // Small table; fetch recent scheduled rows then keep the newest per (feature, model).
        var rows = await db.EvalRuns
            .Where(r => r.RunType == "scheduled")
            .OrderByDescending(r => r.CreatedAt)
            .Take(500)
            .Select(r => new { r.Feature, r.ModelId, r.Score, r.CreatedAt })
            .ToListAsync(ct);

        return rows
            .Where(r => featureSet.Contains(r.Feature))
            .GroupBy(r => (r.Feature, r.ModelId))
            .Select(g => (g.Key.Feature, g.Key.ModelId, (double)g.First().Score))
            .ToList();
    }

    internal static async Task<DbConnection> OpenConnectionAsync(IAppDbContext db, CancellationToken ct)
    {
        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open)
            await conn.OpenAsync(ct);
        return conn;
    }

    internal static async Task<bool> TryAdvisoryLockAsync(DbConnection conn, long key, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT pg_try_advisory_lock(@key)";
        var p = cmd.CreateParameter();
        p.ParameterName = "key";
        p.Value = key;
        cmd.Parameters.Add(p);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is bool b && b;
    }

    internal static async Task UnlockAsync(DbConnection conn, long key)
    {
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT pg_advisory_unlock(@key)";
            var p = cmd.CreateParameter();
            p.ParameterName = "key";
            p.Value = key;
            cmd.Parameters.Add(p);
            // CancellationToken.None on purpose: releasing the lock must not be cancellable by the
            // shutdown token, or the lock leaks onto the pooled connection.
            await cmd.ExecuteScalarAsync(CancellationToken.None);
        }
        catch
        {
            // Connection drop releases the session lock anyway; best-effort unlock.
        }
    }
}
