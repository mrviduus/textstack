using System.Text;
using Application.Common;
using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// What <c>etl-v2</c> runs on: connection strings to legacy and <c>textstack_v2</c>, whether to write, and
/// the SHA-256 of the backup the source was restored from (lowercase hex; the CLI checks it, the ledger's CHECK too),
/// and the file roots: legacy's <c>Storage:RootPath</c> (read only) and V2's <c>Storage:LibraryRoot</c> (bytes are
/// copied there, never moved; a dry run writes neither). Printed (<c>ToString</c>) with its connection strings redacted.
/// </summary>
public sealed record EtlV2Options(
    string Source, string Target, bool DryRun, string? SourceDumpSha = null, string? StorageRoot = null, string? LibraryRoot = null)
{
    private bool PrintMembers(StringBuilder builder)
    {
        builder.Append($"Source = {RedactOrHide(Source)}, Target = {RedactOrHide(Target)}, DryRun = {DryRun}, SourceDumpSha = {SourceDumpSha}, "
            + $"StorageRoot = {StorageRoot}, LibraryRoot = {LibraryRoot}");
        return true;
    }

    // Never the string itself: a placeholder for one that does not parse.
    private static string RedactOrHide(string connectionString)
    {
        try
        {
            return EtlV2.Redact(connectionString);
        }
        catch (ArgumentException)
        {
            return "(not a valid connection string)";
        }
    }
}

/// <summary>
/// One mapper (M3.2/M3.3), run in <see cref="EtlV2.Steps"/> order after the run's ledger row is written.
/// <see cref="Sources"/> (legacy) and <see cref="Targets"/> (V2) are the tables it reads and writes: the
/// run's counts are of those tables, over the steps it runs.
/// </summary>
public sealed record EtlV2Step(
    string Name, IReadOnlyList<string> Sources, IReadOnlyList<string> Targets, Func<EtlV2Context, CancellationToken, Task> RunAsync)
{
    /// <summary>A step that declares no table (tests).</summary>
    public EtlV2Step(string Name, Func<EtlV2Context, CancellationToken, Task> RunAsync) : this(Name, [], [], RunAsync) { }
}

/// <summary>One validation check a step ran, how many failures it found (0 = passed), and the failing rows' ids (ids only, never content).</summary>
public sealed record EtlV2Check(string Name, int Failures, IReadOnlyList<string>? Ids = null);

/// <summary>What a step wrote to one target, or would write on a dry run: a converged re-run inserts and updates nothing.</summary>
public sealed record EtlV2Writes(int Inserted, int Updated, int Unchanged);

/// <summary>What a step reads from and writes to, and where it reports what it would not do silently.</summary>
public sealed class EtlV2Context
{
    // The fence: the run's own ledger row, still open, held FOR SHARE until the write commits. A run closing
    // it as interrupted (it got the lock after this one lost it) waits for that commit, and every later
    // write of this run finds the row closed.
    private const string Fence = "SELECT 1 FROM migration_runs WHERE id = @runId AND finished_at IS NULL FOR SHARE";

    public required bool DryRun { get; init; }

    /// <summary>The run's ledger row; null on a dry run (it writes none).</summary>
    public Guid? RunId { get; init; }

    /// <summary>Legacy's file root (<c>Storage:RootPath</c>), only ever read; null when the run was given none.</summary>
    public string? StorageRoot { get; init; }

    /// <summary>V2's file root (<c>Storage:LibraryRoot</c>); null when the run was given none.</summary>
    public string? LibraryRoot { get; init; }

    /// <summary>Legacy, read-only at the connection level, in one REPEATABLE READ snapshot for the whole run.</summary>
    public required NpgsqlTransaction Source { get; init; }

    /// <summary>
    /// <c>textstack_v2</c>, for the repositories; read-only in a dry run, so a write there fails instead of
    /// landing. A dry-run step computes what it would write and counts it; it does not write and roll back
    /// (a rolled-back transaction still advances sequences).
    /// </summary>
    public required V2DataSource Target { get; init; }

    /// <summary>
    /// The validation checks the steps ran. Fail closed: a run with none cannot succeed
    /// (<c>NoValidationChecks</c>; a dry run, which writes no gate row, reports 0 and passes), and any
    /// failure fails it (<c>ValidationFailed</c>).
    /// </summary>
    public List<EtlV2Check> Checks { get; } = [];

    /// <summary>Rows a step found but did not carry or delete: listed, never auto-deleted.</summary>
    public List<string> OrphanCandidates { get; } = [];

    /// <summary>Cleanups a step would need (a human runs them, never an ordinary retry).</summary>
    public List<string> CleanupActions { get; } = [];

    /// <summary>Per target: what was written, or what a dry run would write.</summary>
    public Dictionary<string, EtlV2Writes> Writes { get; } = [];

    /// <summary>
    /// Set by the catalog step: every intent pair whose edition exists, and whether it is carried (false: refused,
    /// a failed check). Later steps link to a pair's book only through it; null = the catalog step has not run.
    /// </summary>
    internal IReadOnlyDictionary<(Guid UserId, Guid EditionId), bool>? CatalogPairs { get; set; }

    /// <summary>Legacy <c>user_books</c> id → owner, read once per run (the snapshot does not change); see <c>EtlV2Rows.UploadOwnersAsync</c>.</summary>
    internal Dictionary<Guid, Guid>? UploadOwners { get; set; }

    /// <summary>The accounts the users step carries (legacy users and admins), read once per run; see <c>EtlV2Rows.CarriedUserIdsAsync</c>.</summary>
    internal IReadOnlySet<Guid>? CarriedUsers { get; set; }

    /// <summary>A step writes only on a real run and only while no check has failed: after one failure the rest is computed and reported, never written.</summary>
    public bool MayWrite => !DryRun && Checks.All(c => c.Failures == 0);

    /// <summary>
    /// A write transaction on the target holding the fence: throws, holding nothing, when the run's ledger
    /// row is closed or gone (another run took over). Never on a dry run.
    /// </summary>
    public async Task<V2Transaction> BeginWriteAsync(CancellationToken ct)
    {
        if (RunId is not { } runId)
            throw new InvalidOperationException("a dry run writes nothing");
        var tx = await Target.BeginAsync(ct);
        try
        {
            if (await tx.Connection.ExecuteScalarAsync<int?>(new CommandDefinition(Fence, new { runId }, tx.Transaction, cancellationToken: ct)) is null)
                throw new InvalidOperationException($"run {runId} is no longer open in migration_runs (closed by another run); its writes would overlap");
            return tx;
        }
        catch
        {
            await tx.DisposeAsync();
            throw;
        }
    }
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
    IReadOnlyList<EtlV2Check> Checks,
    IReadOnlyList<string> OrphanCandidates,
    IReadOnlyList<string> CleanupActions,
    IReadOnlyDictionary<string, EtlV2Writes> Writes);

/// <summary>
/// The one exception <see cref="EtlV2.RunAsync"/> throws: refused, failed or cancelled, its message scrubbed
/// of passwords. <see cref="RunId"/>: the ledger row recording the failure; null = nothing recorded.
/// <see cref="Canceled"/>: the run's own token was cancelled. What the steps found before it (checks with
/// their ids, orphans, cleanups, per-table writes) comes with it, so a failed dry run still reports them.
/// </summary>
public sealed class EtlV2Exception(string message, Exception? inner, Guid? runId = null, bool canceled = false, EtlV2Context? context = null)
    : Exception(message, inner)
{
    public Guid? RunId => runId;

    public bool Canceled => canceled;

    public IReadOnlyList<EtlV2Check> Checks { get; } = context?.Checks.ToArray() ?? [];

    public IReadOnlyList<string> OrphanCandidates { get; } = context?.OrphanCandidates.ToArray() ?? [];

    public IReadOnlyList<string> CleanupActions { get; } = context?.CleanupActions.ToArray() ?? [];

    public IReadOnlyDictionary<string, EtlV2Writes> Writes { get; } = context?.Writes.ToDictionary() ?? [];
}

/// <summary>The run finished its steps but did not validate: <see cref="Type"/> is the ledger's error type.</summary>
internal sealed class EtlV2ValidationException : Exception
{
    private EtlV2ValidationException(string type, int failures, string message) : base(message) => (Type, Failures) = (type, failures);

    public string Type { get; }

    public int Failures { get; }

    /// <summary>No check ran: 1 failure, the run itself.</summary>
    public static EtlV2ValidationException NoChecks() =>
        new("NoValidationChecks", 1, "no validation check ran; a run cannot succeed unvalidated");

    public static EtlV2ValidationException Failed(int failures) =>
        new("ValidationFailed", failures, $"validation found {failures} failure(s)");
}
