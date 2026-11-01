using Application.Ops;
using Dapper;
using Domain.Ops;

namespace Infrastructure.Persistence.Repositories;

/// <summary>Dapper implementation of <see cref="IEvalRunRepository"/> on <c>textstack_v2</c>.</summary>
public sealed class EvalRunRepository(V2DataSource dataSource) : IEvalRunRepository
{
    private const string Columns = "id, feature, model_id, judge_model_id, score, n, breakdown_json, git_sha, run_type, created_at";

    private const string InsertScore = """
        INSERT INTO eval_runs (id, feature, model_id, judge_model_id, score, n, breakdown_json, git_sha, run_type, created_at)
        VALUES (@Id, @Feature, @ModelId, @JudgeModelId, @Score, @N, CAST(@BreakdownJson AS jsonb), @GitSha, @RunType, now())
        """;

    public async Task AddAsync(IReadOnlyList<EvalScore> scores, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertScore, scores, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
    }

    // On ix_eval_runs_feature_created_at when a feature is given; the table is small otherwise.
    private const string SelectRecent = $"""
        SELECT {Columns} FROM eval_runs
        WHERE (@feature IS NULL OR feature = @feature) AND (@runType IS NULL OR run_type = @runType)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
        """;

    public async Task<IReadOnlyList<EvalScore>> ListRecentAsync(string? feature, string? runType, int limit, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<EvalScore>(new CommandDefinition(SelectRecent, new { feature, runType, limit }, cancellationToken: ct))).AsList();
    }
}
