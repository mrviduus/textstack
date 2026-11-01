namespace Domain.Ops;

/// <summary>
/// One eval score of one feature and model (V2 table <c>eval_runs</c>), written by the eval suite and
/// read by the admin AI Quality page and the scheduled-eval worker. Named apart from the legacy
/// <c>Domain.Entities.EvalRun</c>.
/// </summary>
public class EvalScore
{
    public const string Manual = "manual";
    public const string Scheduled = "scheduled";

    public Guid Id { get; set; }
    public string Feature { get; set; } = "";
    public string ModelId { get; set; } = "";
    public string JudgeModelId { get; set; } = "";
    public decimal Score { get; set; }
    public int N { get; set; }

    /// <summary>Opaque JSON: the per-dimension scores.</summary>
    public string? BreakdownJson { get; set; }

    public string? GitSha { get; set; }

    /// <summary><see cref="Manual"/> or <see cref="Scheduled"/>.</summary>
    public string RunType { get; set; } = Manual;

    public DateTimeOffset CreatedAt { get; set; }
}
