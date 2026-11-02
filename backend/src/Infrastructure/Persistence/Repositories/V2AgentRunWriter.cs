using System.Text.Json;
using Dapper;
using TextStack.Ai.Core;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Writes finished agent runs to <c>textstack_v2</c> (table <c>agent_run</c>): the second
/// implementation of <see cref="IAgentRunWriter"/>, beside the EF <c>DbAgentRunWriter</c> that stays
/// bound to the interface until the cutover. V2 has no catalog, so the record's <c>EditionId</c> is
/// not stored; a user's runs go with the account.
/// </summary>
public sealed class V2AgentRunWriter(V2DataSource dataSource) : IAgentRunWriter
{
    private const string InsertRun = """
        INSERT INTO agent_run (id, agent, user_id, goal, status, output, steps_json, iterations, tokens_in, tokens_out, cost_usd, latency_ms, error, created_at, confidence, tool_calls_count)
        VALUES (@Id, @Agent, @UserId, @Goal, @Status, @Output, CAST(@StepsJson AS jsonb), @Iterations, @TokensIn, @TokensOut, @CostUsd, @LatencyMs, @Error, @CreatedAt, @Confidence, @ToolCallsCount)
        """;

    public async Task WriteAsync(AgentRunRecord run, CancellationToken ct)
    {
        var args = new
        {
            run.Id,
            run.Agent,
            run.UserId,
            run.Goal,
            run.Status,
            run.Output,
            StepsJson = JsonSerializer.Serialize(run.Steps),
            run.Usage.Iterations,
            TokensIn = run.Usage.InputTokensTotal,
            TokensOut = run.Usage.OutputTokensTotal,
            CostUsd = run.Usage.CostUsdTotal,
            run.Usage.LatencyMs,
            run.Error,
            run.CreatedAt,
            run.Confidence,
            run.ToolCallsCount,
        };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertRun, args, cancellationToken: ct));
    }
}
