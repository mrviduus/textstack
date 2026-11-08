using System.Data;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// What <c>etl-v2</c> runs on: connection strings to legacy and <c>textstack_v2</c>, whether to write, and
/// the SHA-256 of the backup the source was restored from (lowercase hex; the CLI checks it, the ledger's CHECK too).
/// </summary>
public sealed record EtlV2Options(string Source, string Target, bool DryRun, string? SourceDumpSha = null);

/// <summary>One mapper (M3.2/M3.3), run in <see cref="EtlV2.Steps"/> order after the run's ledger row is written.</summary>
public sealed record EtlV2Step(string Name, Func<EtlV2Context, CancellationToken, Task> RunAsync);

/// <summary>What a step reads from and writes to, and where it reports what it would not do silently.</summary>
public sealed class EtlV2Context
{
    public required bool DryRun { get; init; }

    /// <summary>Legacy, read-only at the connection level, in one REPEATABLE READ snapshot for the whole run.</summary>
    public required NpgsqlTransaction Source { get; init; }

    /// <summary><c>textstack_v2</c>, for the repositories; read-only in a dry run, so a write there fails instead of landing.</summary>
    public required V2DataSource Target { get; init; }

    /// <summary>Rows a step found but did not carry or delete: listed, never auto-deleted.</summary>
    public List<string> OrphanCandidates { get; } = [];

    /// <summary>Cleanups a step would need (a human runs them, never an ordinary retry).</summary>
    public List<string> CleanupActions { get; } = [];
}

public sealed record EtlV2InterruptedRun(Guid Id, DateTimeOffset StartedAt);

/// <summary>
/// What a run did: no <see cref="RunId"/> on a dry run (it writes no ledger row). <see cref="InterruptedRuns"/>:
/// earlier runs left unfinished, closed as <c>interrupted</c> by this run (a dry run lists them and closes none).
/// Connection strings carry no secrets.
/// </summary>
public sealed record EtlV2Report(
    Guid? RunId,
    bool DryRun,
    string Source,
    string Target,
    string? SourceDumpSha,
    IReadOnlyList<EtlV2InterruptedRun> InterruptedRuns,
    IReadOnlyDictionary<string, long> SourceCounts,
    IReadOnlyDictionary<string, long> TargetCounts,
    IReadOnlyList<string> OrphanCandidates,
    IReadOnlyList<string> CleanupActions);

/// <summary>
/// The legacy → <c>textstack_v2</c> ETL (v2-plan §5.2, M3.1 skeleton): identity check, advisory lock,
/// <c>migration_runs</c> ledger, per-aggregate counts, then the mapper steps. Every failure leaves as an
/// <see cref="InvalidOperationException"/> whose message carries no password.
/// </summary>
public static class EtlV2
{
    /// <summary>
    /// The mappers, in dependency order: users first (every V2 row points at one), then books, then
    /// what hangs on books. Empty until M3.2. A step writes through the V2 repositories and never
    /// deletes on its own: what it would delete goes to <see cref="EtlV2Context.OrphanCandidates"/>.
    /// </summary>
    public static readonly IReadOnlyList<EtlV2Step> Steps = [];

    /// <summary>The session advisory lock on the target ("etl-v2" in ASCII) that keeps runs one at a time.</summary>
    public const long LockKey = 0x65_74_6c_2d_76_32;

    // Cluster + database: two databases of one cluster differ by name, two clusters by system id,
    // whatever host name or port each connection string reaches them by. No superuser needed.
    private const string Identity = "SELECT system_identifier::text || '/' || current_database() FROM pg_control_system()";

    private const string TryLock = "SELECT pg_try_advisory_lock(@LockKey)";

    private const string UnfinishedRuns = "SELECT id, started_at FROM migration_runs WHERE finished_at IS NULL ORDER BY started_at";

    // Only under the lock: an unfinished row then belongs to a run that died. Closed, never deleted.
    private const string CloseInterrupted = """
        UPDATE migration_runs SET outcome = 'interrupted', finished_at = GREATEST(clock_timestamp(), started_at)
        WHERE finished_at IS NULL
        RETURNING id, started_at
        """;

    // started_at is the server's clock_timestamp() (column default), never a client time.
    private const string StartRun = "INSERT INTO migration_runs (id, source_dump_sha) VALUES (@id, @sourceDumpSha)";

    private const string FinishRun = """
        UPDATE migration_runs
        SET finished_at = GREATEST(clock_timestamp(), started_at), outcome = @outcome, counts = CAST(@counts AS jsonb),
            validation = CAST(@validation AS jsonb), validation_failures = @validationFailures
        WHERE id = @id AND finished_at IS NULL
        """;

    // The legacy tables M3.2 (users, uploads) and M3.3 (catalog pairs, vocabulary, insights, sessions) map.
    private const string SourceCounts = """
        SELECT
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM admin_users) AS admin_users,
            (SELECT count(*) FROM user_books) AS user_books,
            (SELECT count(*) FROM user_book_files) AS user_book_files,
            (SELECT count(*) FROM user_chapters) AS user_chapters,
            (SELECT count(*) FROM user_libraries) AS user_libraries,
            (SELECT count(*) FROM highlights) AS highlights,
            (SELECT count(*) FROM vocabulary_words) AS vocabulary_words,
            (SELECT count(*) FROM vocabulary_reviews) AS vocabulary_reviews,
            (SELECT count(*) FROM book_insight) AS book_insight,
            (SELECT count(*) FROM review_question) AS review_question,
            (SELECT count(*) FROM reading_sessions) AS reading_sessions
        """;

    // The V2 tables those land in.
    private const string TargetCounts = """
        SELECT
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM books) AS books,
            (SELECT count(*) FROM book_files) AS book_files,
            (SELECT count(*) FROM book_chapters) AS book_chapters,
            (SELECT count(*) FROM reading_state) AS reading_state,
            (SELECT count(*) FROM annotations) AS annotations,
            (SELECT count(*) FROM vocabulary_words) AS vocabulary_words,
            (SELECT count(*) FROM vocabulary_examples) AS vocabulary_examples,
            (SELECT count(*) FROM vocabulary_reviews) AS vocabulary_reviews,
            (SELECT count(*) FROM book_insight) AS book_insight,
            (SELECT count(*) FROM review_question) AS review_question,
            (SELECT count(*) FROM reading_sessions) AS reading_sessions
        """;

    public static async Task<EtlV2Report> RunAsync(EtlV2Options options, IReadOnlyList<EtlV2Step>? steps = null, CancellationToken ct = default)
    {
        var source = Parse(options.Source, "--source");
        var target = Parse(options.Target, "--target");
        string[] secrets = [.. new[] { source.Password, source.SslPassword, target.Password, target.SslPassword }.Where(s => !string.IsNullOrEmpty(s))!];
        try
        {
            return await RunCoreAsync(source, target, options, steps ?? Steps, secrets, ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            throw new InvalidOperationException(Scrub(e.Message, secrets), e);
        }
    }

    private static async Task<EtlV2Report> RunCoreAsync(
        NpgsqlConnectionStringBuilder source, NpgsqlConnectionStringBuilder target, EtlV2Options options,
        IReadOnlyList<EtlV2Step> steps, string[] secrets, CancellationToken ct)
    {
        var dryRun = options.DryRun;
        // Disposing the data sources closes their connections, which ends the session and with it the lock.
        await using var sourceDb = DataSource.Create(ReadOnly(source.ConnectionString));
        await using var targetDb = new V2DataSource(dryRun ? ReadOnly(target.ConnectionString) : target.ConnectionString);
        await using var sourceConn = await sourceDb.OpenConnectionAsync(ct);
        await using var snapshot = await sourceConn.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await using var targetConn = await targetDb.OpenConnectionAsync(ct);

        var sourceId = await sourceConn.ExecuteScalarAsync<string>(new CommandDefinition(Identity, transaction: snapshot, cancellationToken: ct));
        var targetId = await targetConn.ExecuteScalarAsync<string>(new CommandDefinition(Identity, cancellationToken: ct));
        if (sourceId == targetId)
            throw new InvalidOperationException($"source and target are the same database ({targetId}); etl-v2 reads legacy and writes textstack_v2");
        var violations = await EtlV2SourceAudit.ViolationsAsync(sourceConn, snapshot, ct);
        if (violations.Count > 0)
            throw new InvalidOperationException(
                $"source role {source.Username} can write ({string.Join("; ", violations.Take(5))}{(violations.Count > 5 ? $"; and {violations.Count - 5} more" : "")}); read as the SELECT-only etl_reader (docs/03-ops/v2-etl.md)");
        if (!await targetConn.ExecuteScalarAsync<bool>(new CommandDefinition(TryLock, new { LockKey }, cancellationToken: ct)))
            throw new InvalidOperationException($"another etl-v2 run holds the target's advisory lock {LockKey}; wait for it to finish");

        var interrupted = (await targetConn.QueryAsync<EtlV2InterruptedRun>(
            new CommandDefinition(dryRun ? UnfinishedRuns : CloseInterrupted, cancellationToken: ct))).OrderBy(r => r.StartedAt).ToList();
        Guid? runId = dryRun ? null : Guid.CreateVersion7();
        if (runId is not null)
            // Autocommit: a run killed from here on leaves this row unfinished, for the next run to close as interrupted.
            await targetConn.ExecuteAsync(new CommandDefinition(StartRun, new { id = runId, sourceDumpSha = options.SourceDumpSha }, cancellationToken: ct));

        var context = new EtlV2Context { DryRun = dryRun, Source = snapshot, Target = targetDb };
        Dictionary<string, long> sourceCounts = [];
        try
        {
            sourceCounts = await CountAsync(sourceConn, SourceCounts, snapshot, ct);
            foreach (var step in steps)
                await step.RunAsync(context, ct);
            var targetCounts = await CountAsync(targetConn, TargetCounts, null, ct);
            if (runId is not null)
                await FinishAsync(targetConn, runId.Value, "succeeded", sourceCounts, targetCounts,
                    new { orphanCandidates = context.OrphanCandidates, cleanupActions = context.CleanupActions }, 0, ct);
            return new EtlV2Report(runId, dryRun, Redact(source.ConnectionString), Redact(target.ConnectionString), options.SourceDumpSha, interrupted,
                sourceCounts, targetCounts, context.OrphanCandidates, context.CleanupActions);
        }
        catch (Exception e) when (runId is not null)
        {
            try
            {
                // Type and SQLSTATE only: a message can quote row values (the caller prints it, scrubbed, to stderr).
                // validation_failures = 1, the run itself: 0004 writes it with validation or not at all.
                var type = e is OperationCanceledException ? nameof(OperationCanceledException) : e.GetType().Name;
                var sqlState = (e as NpgsqlException ?? e.InnerException as NpgsqlException)?.SqlState;
                await FinishAsync(targetConn, runId.Value, "failed", sourceCounts, null,
                    new { error = new { type, sqlState } }, 1, CancellationToken.None);
            }
            catch (Exception)
            {
                // The target is gone too (or the row was closed): the next run closes it as interrupted.
            }
            throw;
        }
    }

    private static async Task FinishAsync(NpgsqlConnection conn, Guid id, string outcome, Dictionary<string, long> source,
        Dictionary<string, long>? target, object validation, int validationFailures, CancellationToken ct)
    {
        var finished = await conn.ExecuteAsync(new CommandDefinition(FinishRun, new
        {
            id,
            outcome,
            counts = JsonSerializer.Serialize(new { source, target }),
            validation = JsonSerializer.Serialize(validation),
            validationFailures,
        }, cancellationToken: ct));
        if (finished == 0)
            throw new InvalidOperationException($"run {id} was closed as interrupted by another run; its writes overlapped");
    }

    private static async Task<Dictionary<string, long>> CountAsync(NpgsqlConnection conn, string sql, NpgsqlTransaction? tx, CancellationToken ct)
    {
        var row = (IDictionary<string, object>)await conn.QuerySingleAsync(new CommandDefinition(sql, transaction: tx, cancellationToken: ct));
        return row.ToDictionary(c => c.Key, c => (long)c.Value);
    }

    /// <summary>The connection string with every session defaulting to read-only transactions: a write fails with 25006.</summary>
    public static string ReadOnly(string connectionString)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        builder.Options = $"{builder.Options} -c default_transaction_read_only=on".Trim();
        return builder.ConnectionString;
    }

    /// <summary>The connection string without its passwords, for any log, report or error.</summary>
    public static string Redact(string connectionString) =>
        new NpgsqlConnectionStringBuilder(connectionString) { Password = null, SslPassword = null }.ConnectionString;

    private static NpgsqlConnectionStringBuilder Parse(string connectionString, string name)
    {
        try
        {
            return new NpgsqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            // Not the parser's message: it may quote the string back.
            throw new InvalidOperationException($"{name} is not a valid connection string");
        }
    }

    private static string Scrub(string message, string[] secrets) =>
        secrets.Aggregate(message, (m, secret) => m.Replace(secret, "***", StringComparison.Ordinal));
}
