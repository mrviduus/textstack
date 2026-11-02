using Dapper;
using Infrastructure.Persistence.Repositories;
using TextStack.Ai.Core;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Ops;

public class OpsWritersTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task WriteAsync_Trace_IsStored()
    {
        var user = await db.NewReaderAsync();
        var trace = NewTrace(user);

        await new V2LlmTraceWriter(db.DataSource).WriteAsync(trace, Ct);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var stored = await conn.QuerySingleAsync<(string FeatureTag, int TokensIn, decimal CostUsd, Guid UserId)>(new CommandDefinition(
            "SELECT feature_tag, tokens_in, cost_usd, user_id FROM llm_traces WHERE id = @Id", trace, cancellationToken: Ct));
        Assert.Equal(("explain", 10, 0.000123m, user), stored);
    }

    [Fact]
    public async Task WriteAsync_AgentRun_IsStoredWithItsSteps()
    {
        var user = await db.NewReaderAsync();
        var run = NewRun(user);

        await new V2AgentRunWriter(db.DataSource).WriteAsync(run, Ct);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var stored = await conn.QuerySingleAsync<(string Status, int Iterations, int ToolCallsCount, int Steps)>(new CommandDefinition(
            "SELECT status, iterations, tool_calls_count, jsonb_array_length(steps_json) FROM agent_run WHERE id = @Id", run, cancellationToken: Ct));
        Assert.Equal(("completed", 1, 2, 1), stored);
    }
}
