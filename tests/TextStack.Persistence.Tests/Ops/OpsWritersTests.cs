using System.Text.Json;
using Dapper;
using Infrastructure.Persistence.Repositories;
using TextStack.Ai.Core;

namespace TextStack.Persistence.Tests.Ops;

public class OpsWritersTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A trace of one call made for <paramref name="userId"/>.</summary>
    public static LlmTrace Trace(Guid userId) => new(
        Guid.NewGuid(), "explain", "gpt-test", "hash", "system", """[{"role":"user","content":"hi"}]""", "hello",
        null, 10, 5, 0.000123m, 42, userId, null, null, DateTimeOffset.UtcNow);

    /// <summary>A completed one-step run for <paramref name="userId"/>, on a catalog edition V2 does not keep.</summary>
    public static AgentRunRecord Run(Guid userId) => new(
        Guid.NewGuid(), "tutor", userId, Guid.NewGuid(), "explain chapter 1", "completed", "done",
        [new AgentStep(0, "final", JsonSerializer.SerializeToElement(new { text = "done" }), DateTimeOffset.UtcNow)],
        new AgentUsage(1, 10, 5, 0.0001m, 42), null, DateTimeOffset.UtcNow, 0.9, 2);

    [Fact]
    public async Task WriteAsync_Trace_IsStored()
    {
        var user = await db.NewReaderAsync();
        var trace = Trace(user);

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
        var run = Run(user);

        await new V2AgentRunWriter(db.DataSource).WriteAsync(run, Ct);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var stored = await conn.QuerySingleAsync<(string Status, int Iterations, int ToolCallsCount, int Steps)>(new CommandDefinition(
            "SELECT status, iterations, tool_calls_count, jsonb_array_length(steps_json) FROM agent_run WHERE id = @Id", run, cancellationToken: Ct));
        Assert.Equal(("completed", 1, 2, 1), stored);
    }
}
