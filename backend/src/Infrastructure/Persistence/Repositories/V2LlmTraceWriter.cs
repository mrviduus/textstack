using Dapper;
using TextStack.Ai.Core;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Writes gateway traces to <c>textstack_v2</c> (table <c>llm_traces</c>): the second implementation
/// of <see cref="ILlmTraceWriter"/>, beside the EF <c>DbLlmTraceWriter</c> that stays bound to the
/// interface until the cutover. <c>user_id</c> has no FK by design: a trace outlives its user.
/// </summary>
public sealed class V2LlmTraceWriter(V2DataSource dataSource) : ILlmTraceWriter
{
    private const string InsertTrace = """
        INSERT INTO llm_traces (id, feature_tag, model_id, prompt_hash, system_prompt, messages_json, response_text, tool_calls_json, tokens_in, tokens_out, cost_usd, latency_ms, user_id, trace_parent_id, error, created_at)
        VALUES (@Id, @FeatureTag, @ModelId, @PromptHash, @SystemPrompt, CAST(@MessagesJson AS jsonb), @ResponseText, CAST(@ToolCallsJson AS jsonb), @TokensIn, @TokensOut, @CostUsd, @LatencyMs, @UserId, @TraceParentId, @Error, @CreatedAt)
        """;

    public async Task WriteAsync(LlmTrace trace, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertTrace, trace, cancellationToken: ct));
    }
}
