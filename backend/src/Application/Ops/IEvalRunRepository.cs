using Domain.Ops;

namespace Application.Ops;

/// <summary>The V2 eval scores (table <c>eval_runs</c>); not user-owned.</summary>
public interface IEvalRunRepository
{
    /// <summary>Stores the scores of one suite run, all or none.</summary>
    Task AddAsync(IReadOnlyList<EvalScore> scores, CancellationToken ct);

    /// <summary>
    /// The newest <paramref name="limit"/> scores, newest first; only those of
    /// <paramref name="feature"/> and of <paramref name="runType"/> when given.
    /// </summary>
    Task<IReadOnlyList<EvalScore>> ListRecentAsync(string? feature, string? runType, int limit, CancellationToken ct);
}
