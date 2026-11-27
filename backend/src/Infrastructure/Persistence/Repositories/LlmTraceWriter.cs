using Dapper;
using TextStack.Ai.Core;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Writes gateway traces to <c>textstack_v2</c> (table <c>llm_traces</c>): the second implementation
/// of <see cref="ILlmTraceWriter"/>, beside the EF <c>DbLlmTraceWriter</c> that stays bound to the
/// interface until the cutover. <c>user_id</c> has no FK by design: a trace outlives its user.
/// </summary>
public sealed class LlmTraceWriter(AppDataSource dataSource) : ILlmTraceWriter, Application.Ai.ILlmSpendSource
{
    private const string SumCost = """
        SELECT coalesce(sum(cost_usd), 0) FROM llm_traces WHERE feature_tag = @featureTag AND created_at >= @since
        """;

    /// <summary>
    /// Today's seed for the spend tracker in v2 mode, where the traces are written here. Sync because the tracker's
    /// seed is (it ran a sync EF sum on legacy); once per feature per day.
    /// </summary>
    public decimal SampledCostSince(string featureTag, DateTimeOffset since)
    {
        using var conn = dataSource.OpenConnection();
        return conn.ExecuteScalar<decimal>(SumCost, new { featureTag, since });
    }

    private const string InsertTrace = """
        INSERT INTO llm_traces (id, feature_tag, model_id, prompt_hash, system_prompt, messages_json, response_text, tool_calls_json, tokens_in, tokens_out, cost_usd, latency_ms, user_id, trace_parent_id, error, created_at)
        VALUES (@Id, @FeatureTag, @ModelId, @PromptHash, @SystemPrompt, CAST(@MessagesJson AS jsonb), @ResponseText, CAST(@ToolCallsJson AS jsonb), @TokensIn, @TokensOut, @CostUsd, @LatencyMs, @UserId, @TraceParentId, @Error, @CreatedAt)
        """;

    // Same rule as the legacy sweep (RetentionCleanupWorker.LlmTraceTextToScrub): text goes, cost stays.
    // error too: a provider's message can echo the prompt (review 2026-10 #26).
    private const string ScrubBatch = """
        UPDATE llm_traces SET system_prompt = NULL, messages_json = '[]'::jsonb, response_text = NULL, tool_calls_json = NULL, error = NULL
        WHERE id IN (
            SELECT id FROM llm_traces
            WHERE created_at < @cutoff
              AND (messages_json <> '[]'::jsonb OR system_prompt IS NOT NULL OR response_text IS NOT NULL OR tool_calls_json IS NOT NULL OR error IS NOT NULL)
            ORDER BY id LIMIT @limit)
        """;

    public async Task WriteAsync(LlmTrace trace, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertTrace, trace, cancellationToken: ct));
    }

    /// <summary>Scrubs the text of up to <paramref name="limit"/> traces older than <paramref name="cutoff"/> (#941); how many.</summary>
    public async Task<int> ScrubTextBatchAsync(DateTimeOffset cutoff, int limit, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(ScrubBatch, new { cutoff, limit }, cancellationToken: ct));
    }
}
