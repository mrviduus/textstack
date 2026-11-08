using System.Data;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// The legacy → <c>textstack_v2</c> ETL (v2-plan §5.2, M3.1 skeleton): identity check, advisory lock,
/// <c>migration_runs</c> ledger, counts of the steps' tables, then the mapper steps. Every failure leaves as an
/// <see cref="EtlV2Exception"/> whose message carries no password.
/// </summary>
public static class EtlV2
{
    /// <summary>
    /// The mappers, in dependency order: users first (every V2 row points at one), then books and files,
    /// then what hangs on them. A step never deletes: what it would delete goes to
    /// <see cref="EtlV2Context.OrphanCandidates"/> or <see cref="EtlV2Context.CleanupActions"/>.
    /// </summary>
    public static readonly IReadOnlyList<EtlV2Step> Steps = [];

    /// <summary>The session advisory lock on the target ("etl-v2" in ASCII) that keeps runs one at a time.</summary>
    public const long LockKey = 0x65_74_6c_2d_76_32;

    // Cluster + database: two databases of one cluster differ by name, two clusters by system id,
    // whatever host name or port each connection string reaches them by. No superuser needed.
    private const string Identity = "SELECT system_identifier::text || '/' || current_database() FROM pg_control_system()";

    private const string TryLock = "SELECT pg_try_advisory_lock(@LockKey)";

    /// <summary>A <c>pg_locks</c> predicate for etl-v2's lock: a bigint key is classid = high 32 bits, objid = low 32, objsubid = 1.</summary>
    internal static readonly string LockMatch =
        $"locktype = 'advisory' AND classid = {LockKey >> 32} AND objid = {LockKey & 0xFFFF_FFFF} AND objsubid = 1";

    // This session still holds it.
    private static readonly string HoldsLock = $"SELECT EXISTS (SELECT FROM pg_locks WHERE pid = pg_backend_pid() AND granted AND {LockMatch})";

    // The ledger's own statements run to completion whatever the run's token says (a cancel must never
    // leave "did it commit?" open), bounded by this instead.
    private const int LedgerTimeoutSeconds = 60;

    private const string UnfinishedRuns = "SELECT id, started_at FROM migration_runs WHERE finished_at IS NULL ORDER BY started_at";

    // Only under the lock: an unfinished row then belongs to a run that died. Closed, never deleted.
    private const string CloseInterrupted = """
        WITH closed AS (
            UPDATE migration_runs SET outcome = 'interrupted', finished_at = GREATEST(clock_timestamp(), started_at)
            WHERE finished_at IS NULL
            RETURNING id, started_at)
        SELECT id, started_at FROM closed ORDER BY started_at
        """;

    // started_at is the server's clock_timestamp() (column default), never a client time.
    private const string StartRun = "INSERT INTO migration_runs (id, source_dump_sha) VALUES (@id, @sourceDumpSha)";

    private const string FinishRun = """
        UPDATE migration_runs
        SET finished_at = GREATEST(clock_timestamp(), started_at), outcome = @outcome, counts = CAST(@counts AS jsonb),
            validation = CAST(@validation AS jsonb), validation_failures = @validationFailures
        WHERE id = @id AND finished_at IS NULL
        """;

    // A table name a step declares: a code constant, checked anyway before it reaches SQL (rule 3).
    private static readonly System.Text.RegularExpressions.Regex TableName = new("^[a-z_][a-z0-9_]*$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>One row of <c>count(*)</c> per table, named by the table: the tables the steps declare.</summary>
    private static string CountsOf(IEnumerable<string> tables) =>
        "SELECT " + string.Join(", ", tables.Distinct().Order(StringComparer.Ordinal).Select(t =>
            TableName.IsMatch(t) ? $"(SELECT count(*) FROM {t}) AS {t}" : throw new ArgumentException($"not a table name: {t}")));

    public static async Task<EtlV2Report> RunAsync(EtlV2Options options, IReadOnlyList<EtlV2Step>? steps = null, CancellationToken ct = default)
    {
        var source = Parse(options.Source, "--source");
        var target = Parse(options.Target, "--target");
        string[] secrets = [.. new[] { source.Password, source.SslPassword, target.Password, target.SslPassword }.Where(s => !string.IsNullOrEmpty(s))!];
        try
        {
            return await RunCoreAsync(source, target, options, steps ?? Steps, secrets, ct);
        }
        catch (EtlV2Exception)
        {
            throw;
        }
        catch (Exception e)
        {
            // Before the steps' context: nothing recorded.
            throw Edge(e, secrets, null, null, ct);
        }
    }

    /// <summary><paramref name="e"/> as the edge exception: cancelled by the run's own token, or failed, its message scrubbed.</summary>
    private static EtlV2Exception Edge(Exception e, string[] secrets, Guid? runId, EtlV2Context? context, CancellationToken ct) =>
        e is OperationCanceledException && ct.IsCancellationRequested
            ? new(runId is null ? "cancelled; nothing recorded" : $"cancelled; run {runId} recorded as failed", e, runId, canceled: true, context)
            : new(Scrub(e.Message, secrets), e, runId, canceled: false, context);

    private static async Task<EtlV2Report> RunCoreAsync(
        NpgsqlConnectionStringBuilder source, NpgsqlConnectionStringBuilder target, EtlV2Options options,
        IReadOnlyList<EtlV2Step> steps, string[] secrets, CancellationToken ct)
    {
        var dryRun = options.DryRun;
        // Disposing the data sources closes their connections, which ends the session and with it the lock.
        await using var sourceDb = DataSource.Create(Session(source.ConnectionString, readOnly: true));
        await using var targetDb = new V2DataSource(Session(target.ConnectionString, readOnly: dryRun));
        await using var sourceConn = await sourceDb.OpenConnectionAsync(ct);
        await using var snapshot = await sourceConn.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await using var targetConn = await targetDb.OpenConnectionAsync(ct);

        var sourceId = await sourceConn.ExecuteScalarAsync<string>(new CommandDefinition(Identity, transaction: snapshot, cancellationToken: ct));
        var targetId = await targetConn.ExecuteScalarAsync<string>(new CommandDefinition(Identity, cancellationToken: ct));
        if (sourceId == targetId)
            throw new InvalidOperationException($"source and target are the same database ({targetId}); etl-v2 reads legacy and writes textstack_v2");
        var (login, violations) = await EtlV2SourceAudit.AuditAsync(sourceConn, snapshot, ct);
        if (violations.Count > 0)
            throw new InvalidOperationException(
                $"source login {login} can write ({string.Join("; ", violations.Take(5))}{(violations.Count > 5 ? $"; and {violations.Count - 5} more" : "")}); read as the SELECT-only etl_reader (docs/03-ops/v2-etl.md)");
        if (!await targetConn.ExecuteScalarAsync<bool>(new CommandDefinition(TryLock, new { LockKey }, cancellationToken: ct)))
            throw new InvalidOperationException($"another etl-v2 run holds the target's advisory lock {LockKey}; wait for it to finish");

        var interrupted = (await targetConn.QueryAsync<EtlV2InterruptedRun>(
            new CommandDefinition(dryRun ? UnfinishedRuns : CloseInterrupted, cancellationToken: ct))).AsList();
        // Written to the ledger only when not a dry run; every branch below is on dryRun.
        var runId = Guid.CreateVersion7();
        if (!dryRun)
            // Autocommit: a run killed from here on leaves this row unfinished, for the next run to close as interrupted.
            await targetConn.ExecuteAsync(new CommandDefinition(StartRun, new { id = runId, sourceDumpSha = options.SourceDumpSha },
                commandTimeout: LedgerTimeoutSeconds, cancellationToken: CancellationToken.None));

        var context = new EtlV2Context
        {
            DryRun = dryRun,
            RunId = dryRun ? null : runId,
            Source = snapshot,
            Target = targetDb,
            StorageRoot = options.StorageRoot,
            LibraryRoot = options.LibraryRoot,
        };
        Dictionary<string, long> sourceCounts = [];
        try
        {
            // Inside the try: a cancel that arrived during the INSERT is recorded on the row it made.
            ct.ThrowIfCancellationRequested();
            sourceCounts = await CountAsync(sourceConn, steps.SelectMany(s => s.Sources), snapshot, ct);
            foreach (var step in steps)
            {
                await EnsureLockAsync(targetConn, ct);
                await step.RunAsync(context, ct);
            }
            // Fail closed where a gate row is written: success means checks ran and found nothing, never
            // "no check ran". A dry run writes no gate row; it reports 0 checks (the CLI warns) and passes.
            if (context.Checks.Count == 0 && !dryRun)
                throw EtlV2ValidationException.NoChecks();
            var failures = context.Checks.Sum(c => c.Failures);
            if (failures > 0)
                throw EtlV2ValidationException.Failed(failures);
            var targetCounts = await CountAsync(targetConn, steps.SelectMany(s => s.Targets), null, ct);
            if (!dryRun)
            {
                await EnsureLockAsync(targetConn, ct);
                // Past this statement the run is succeeded or failed by what committed, not by a late cancel.
                await FinishAsync(targetConn, runId, "succeeded", sourceCounts, targetCounts, new
                {
                    checks = context.Checks,
                    orphanCandidates = context.OrphanCandidates,
                    cleanupActions = context.CleanupActions,
                    writes = context.Writes,
                }, 0);
            }
            return new EtlV2Report(dryRun ? null : runId, dryRun, Redacted(source), Redacted(target), options.SourceDumpSha, interrupted,
                sourceCounts, targetCounts, context.Checks, context.OrphanCandidates, context.CleanupActions, context.Writes);
        }
        catch (Exception e)
        {
            if (dryRun)
                throw Edge(e, secrets, null, context, ct);
            try
            {
                // Type and SQLSTATE only: a message can quote row values (the caller prints it, scrubbed, to stderr).
                // validation_failures: the checks' total when validation ran and failed, else 1 (the run itself);
                // 0004 writes it with validation or not at all.
                var (type, failures) = e switch
                {
                    EtlV2ValidationException v => (v.Type, v.Failures),
                    OperationCanceledException => (nameof(OperationCanceledException), 1),
                    _ => (e.GetType().Name, 1),
                };
                var sqlState = (e as NpgsqlException ?? e.InnerException as NpgsqlException)?.SqlState;
                await FinishAsync(targetConn, runId, "failed", sourceCounts, null,
                    new { error = new { type, sqlState }, checks = context.Checks }, failures);
            }
            catch (Exception)
            {
                // The target is gone too (or the row was closed): the next run closes it as interrupted.
            }
            throw Edge(e, secrets, runId, context, ct);
        }
    }

    /// <summary>Throws unless the lock connection is alive and still holds etl-v2's lock: without it, another run may be writing.</summary>
    private static async Task EnsureLockAsync(NpgsqlConnection lockConn, CancellationToken ct)
    {
        bool held;
        try
        {
            held = await lockConn.ExecuteScalarAsync<bool>(new CommandDefinition(HoldsLock, cancellationToken: ct));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            throw new InvalidOperationException("lock lost: another run may be writing (the lock connection failed)", e);
        }
        if (!held)
            throw new InvalidOperationException("lock lost: another run may be writing");
    }

    private static async Task FinishAsync(NpgsqlConnection conn, Guid id, string outcome, Dictionary<string, long> source,
        Dictionary<string, long>? target, object validation, int validationFailures)
    {
        var finished = await conn.ExecuteAsync(new CommandDefinition(FinishRun, new
        {
            id,
            outcome,
            counts = JsonSerializer.Serialize(new { source, target }),
            validation = JsonSerializer.Serialize(validation),
            validationFailures,
        }, commandTimeout: LedgerTimeoutSeconds, cancellationToken: CancellationToken.None));
        if (finished == 0)
            throw new InvalidOperationException($"run {id} was closed as interrupted by another run; its writes overlapped");
    }

    private static async Task<Dictionary<string, long>> CountAsync(NpgsqlConnection conn, IEnumerable<string> tables, NpgsqlTransaction? tx, CancellationToken ct)
    {
        var sql = CountsOf(tables);
        if (sql == "SELECT ")
            return [];
        var row = (IDictionary<string, object>)await conn.QuerySingleAsync(new CommandDefinition(sql, transaction: tx, cancellationToken: ct));
        return row.ToDictionary(c => c.Key, c => (long)c.Value);
    }

    /// <summary>The connection string with every session defaulting to read-only transactions: a write fails with 25006.</summary>
    internal static string ReadOnly(string connectionString) => Session(connectionString, readOnly: true);

    // No server-side or client-side time limit: production's database defaults statement_timeout to 10 s,
    // and the run holds its source snapshot open, idle, while it writes the target.
    private static string Session(string connectionString, bool readOnly)
    {
        // Keepalive: the lock connection idles through every step; a dead peer must show at the next check.
        var builder = new NpgsqlConnectionStringBuilder(connectionString) { CommandTimeout = 0, KeepAlive = 30 };
        var options = $"{builder.Options} -c statement_timeout=0 -c idle_in_transaction_session_timeout=0";
        builder.Options = (readOnly ? options + " -c default_transaction_read_only=on" : options).Trim();
        return builder.ConnectionString;
    }

    /// <summary>The connection string without its passwords, for any log, report or error.</summary>
    public static string Redact(string connectionString) => Redacted(new NpgsqlConnectionStringBuilder(connectionString));

    // Clears the builder's passwords in place: only for one the run is done connecting with.
    private static string Redacted(NpgsqlConnectionStringBuilder builder)
    {
        builder.Password = null;
        builder.SslPassword = null;
        return builder.ConnectionString;
    }

    private static NpgsqlConnectionStringBuilder Parse(string connectionString, string name)
    {
        try
        {
            return new NpgsqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            // Not the parser's message: it may quote the string back.
            throw new EtlV2Exception($"{name} is not a valid connection string", null);
        }
    }

    private static string Scrub(string message, string[] secrets) =>
        secrets.Aggregate(message, (m, secret) => m.Replace(secret, "***", StringComparison.Ordinal));
}
