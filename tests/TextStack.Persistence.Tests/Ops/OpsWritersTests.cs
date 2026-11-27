using Dapper;
using Infrastructure.Persistence.Repositories;
using TextStack.Ai.Core;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Ops;

public class OpsWritersTests(PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task WriteAsync_Trace_IsStored()
    {
        var user = await db.NewReaderAsync();
        var trace = NewTrace(user);

        await new LlmTraceWriter(db.DataSource).WriteAsync(trace, Ct);

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

        await new AgentRunWriter(db.DataSource).WriteAsync(run, Ct);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var stored = await conn.QuerySingleAsync<(string Status, int Iterations, int ToolCallsCount, int Steps)>(new CommandDefinition(
            "SELECT status, iterations, tool_calls_count, jsonb_array_length(steps_json) FROM agent_run WHERE id = @Id", run, cancellationToken: Ct));
        Assert.Equal(("completed", 1, 2, 1), stored);
    }

    [Fact]
    public async Task ScrubTextBatchAsync_OldTrace_TextGoesCostStays()
    {
        var user = await db.NewReaderAsync();
        var old = NewTrace(user) with { CreatedAt = DateTimeOffset.UtcNow.AddDays(-31), Error = "provider echoed the prompt" };
        var recent = NewTrace(user);
        var writer = new LlmTraceWriter(db.DataSource);
        await writer.WriteAsync(old, Ct);
        await writer.WriteAsync(recent, Ct);

        var cutoff = DateTimeOffset.UtcNow.AddDays(-30);
        while (await writer.ScrubTextBatchAsync(cutoff, 500, Ct) > 0) { } // other tests' traces may share the database
        Assert.Equal(0, await writer.ScrubTextBatchAsync(cutoff, 500, Ct));

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var rows = (await conn.QueryAsync<(Guid Id, string? SystemPrompt, string Messages, string? Response, int TokensIn)>(new CommandDefinition(
            "SELECT id, system_prompt, messages_json::text, coalesce(response_text, error), tokens_in FROM llm_traces WHERE id IN (@a, @b)",
            new { a = old.Id, b = recent.Id }, cancellationToken: Ct))).ToDictionary(r => r.Id);
        Assert.Equal((null, "[]", null, 10), (rows[old.Id].SystemPrompt, rows[old.Id].Messages, rows[old.Id].Response, rows[old.Id].TokensIn));
        Assert.Equal("system", rows[recent.Id].SystemPrompt);
    }

    [Fact]
    public async Task DeleteOlderThanAsync_OldRun_GoesRecentStays()
    {
        var user = await db.NewReaderAsync();
        var old = NewRun(user) with { CreatedAt = DateTimeOffset.UtcNow.AddDays(-31) };
        var recent = NewRun(user);
        var writer = new AgentRunWriter(db.DataSource);
        await writer.WriteAsync(old, Ct);
        await writer.WriteAsync(recent, Ct);

        Assert.True(await writer.DeleteOlderThanAsync(DateTimeOffset.UtcNow.AddDays(-30), Ct) >= 1);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var left = await conn.QueryAsync<Guid>(new CommandDefinition(
            "SELECT id FROM agent_run WHERE id IN (@a, @b)", new { a = old.Id, b = recent.Id }, cancellationToken: Ct));
        Assert.Equal([recent.Id], left);
    }
}
