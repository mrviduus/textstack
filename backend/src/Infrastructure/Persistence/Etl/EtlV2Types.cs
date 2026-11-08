using System.Text;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// What <c>etl-v2</c> runs on: connection strings to legacy and <c>textstack_v2</c>, whether to write, and
/// the SHA-256 of the backup the source was restored from (lowercase hex; the CLI checks it, the ledger's CHECK too).
/// Printed (<c>ToString</c>) with its connection strings redacted.
/// </summary>
public sealed record EtlV2Options(string Source, string Target, bool DryRun, string? SourceDumpSha = null)
{
    private bool PrintMembers(StringBuilder builder)
    {
        builder.Append($"Source = {EtlV2.RedactOrHide(Source)}, Target = {EtlV2.RedactOrHide(Target)}, DryRun = {DryRun}, SourceDumpSha = {SourceDumpSha}");
        return true;
    }
}

/// <summary>One mapper (M3.2/M3.3), run in <see cref="EtlV2.Steps"/> order after the run's ledger row is written.</summary>
public sealed record EtlV2Step(string Name, Func<EtlV2Context, CancellationToken, Task> RunAsync);

/// <summary>One validation check a step ran, and how many failures it found (0 = passed).</summary>
public sealed record EtlV2Check(string Name, int Failures);

/// <summary>What a step reads from and writes to, and where it reports what it would not do silently.</summary>
public sealed class EtlV2Context
{
    public required bool DryRun { get; init; }

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
    IReadOnlyList<string> CleanupActions);

/// <summary>The run's own token was cancelled. <see cref="RunId"/>: the ledger row recorded as failed; null = nothing recorded.</summary>
public sealed class EtlV2CanceledException(Guid? runId, Exception inner, CancellationToken token)
    : OperationCanceledException(runId is null ? "cancelled; nothing recorded" : $"cancelled; run {runId} recorded as failed", inner, token)
{
    public Guid? RunId => runId;
}

/// <summary>The run finished its steps but did not validate: <see cref="Type"/> is the ledger's error type.</summary>
internal sealed class EtlV2ValidationException(string type, int failures)
    : Exception(type == "NoValidationChecks" ? "no validation check ran; a run cannot succeed unvalidated" : $"validation found {failures} failure(s)")
{
    public string Type => type;

    public int Failures => failures;
}
