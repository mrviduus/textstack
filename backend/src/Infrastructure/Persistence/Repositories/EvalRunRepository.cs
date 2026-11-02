using Application.Ops;
using Dapper;
using Domain.Ops;

namespace Infrastructure.Persistence.Repositories;

/// <summary>Dapper implementation of <see cref="IEvalRunRepository"/> on <c>textstack_v2</c>.</summary>
public sealed class EvalRunRepository(V2DataSource dataSource) : IEvalRunRepository
{
    private const string Columns = "id, feature, model_id, judge_model_id, score, n, breakdown_json, git_sha, run_type, created_at";

    // One statement for the whole run, so a failure stores none of it.
    private const string InsertScores = """
        INSERT INTO eval_runs (id, feature, model_id, judge_model_id, score, n, breakdown_json, git_sha, run_type, created_at)
        SELECT e.id, e.feature, e.model_id, e.judge_model_id, e.score, e.n, CAST(e.breakdown_json AS jsonb), e.git_sha, e.run_type, now()
        FROM unnest(@ids, @features, @modelIds, @judgeModelIds, @scores, @ns, @breakdowns, @gitShas, @runTypes)
            AS e(id, feature, model_id, judge_model_id, score, n, breakdown_json, git_sha, run_type)
        """;

    public async Task AddAsync(IReadOnlyList<EvalScore> scores, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertScores, new
        {
            ids = scores.Select(e => e.Id).ToArray(),
            features = scores.Select(e => e.Feature).ToArray(),
            modelIds = scores.Select(e => e.ModelId).ToArray(),
            judgeModelIds = scores.Select(e => e.JudgeModelId).ToArray(),
            scores = scores.Select(e => e.Score).ToArray(),
            ns = scores.Select(e => e.N).ToArray(),
            breakdowns = scores.Select(e => e.BreakdownJson).ToArray(),
            gitShas = scores.Select(e => e.GitSha).ToArray(),
            runTypes = scores.Select(e => e.RunType).ToArray(),
        }, cancellationToken: ct));
    }

    // One statement for every filter: the generic plan cannot use the feature index, and the table is small.
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
