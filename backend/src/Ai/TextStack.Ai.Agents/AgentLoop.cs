using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace TextStack.Ai.Agents;

/// <summary>
/// One event from a streamed agent run (AI-037a): either a recorded <see cref="Step"/> as it happens,
/// or the terminal <see cref="Result"/>. Exactly one is non-null.
/// </summary>
public sealed record AgentEvent(AgentStep? Step, AgentResult<string>? Result)
{
    public static AgentEvent OfStep(AgentStep step) => new(step, null);
    public static AgentEvent Done(AgentResult<string> result) => new(null, result);
}

/// <summary>
/// The hand-rolled plan → act → observe loop (Phase 6, AI-034) every concrete agent runs on. Each
/// iteration: ask the model (with the agent's allowed tool schemas); if it answers without a tool
/// call, that's the final answer; otherwise dispatch the requested tools (validated, in parallel,
/// failures returned as data so the agent can recover) and feed the results back for the next turn.
/// Bounded by <see cref="AgentLoopOptions"/> — a hard iteration cap AND an optional cumulative cost
/// cap — so it can never loop forever or burn the budget; exhausting either throws
/// <see cref="AgentBudgetExhaustedException"/>. Every turn is recorded as an <see cref="AgentStep"/>
/// for a transparent, persistable transcript. Generic over any <see cref="ILlmService"/> + tool set;
/// concrete agents just supply the prompt, allowed tools and options.
/// </summary>
public sealed class AgentLoop(ILlmService llm, IToolRegistry tools, ToolDispatcher dispatcher)
{
    /// <summary>
    /// Runs the loop to completion and returns the final result. Built on <see cref="StreamAsync"/> —
    /// for non-streaming callers (e.g. the eval, AI-039). Budget exhaustion still throws
    /// <see cref="AgentBudgetExhaustedException"/> (with its transcript).
    /// </summary>
    public async Task<AgentResult<string>> RunAsync(
        AgentInput input, AgentContext ctx, AgentLoopOptions options, CancellationToken ct)
    {
        await foreach (var e in StreamAsync(input, ctx, options, ct))
        {
            if (e.Result is { } result)
                return result;
        }
        // Unreachable: the loop either yields a Done event or throws on budget exhaustion.
        throw new InvalidOperationException("Agent stream ended without a result.");
    }

    /// <summary>
    /// Streams the run step-by-step (AI-037a): an <see cref="AgentEvent"/> per recorded step as it
    /// happens, then a terminal Done event carrying the final <see cref="AgentResult{T}"/>. The
    /// endpoint (AI-037b) maps these to SSE so the reader sees the agent's progress. Budget exhaustion
    /// throws after the partial steps have already streamed.
    /// </summary>
    public async IAsyncEnumerable<AgentEvent> StreamAsync(
        AgentInput input, AgentContext ctx, AgentLoopOptions options,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // One span per agent run, for every agent (Enrichment / Tutor /
        // crews) — RunAsync delegates here, so this is the single seam. `using` is legal in an
        // iterator and disposes on normal completion, `yield break`, a throw, AND consumer
        // abandonment, so the outcome is always recorded. FeatureTag IS the agent identity in this
        // codebase (bookmeta.agent / librarian.agent / tutor.agent) and is the same key Ai:Routes is
        // indexed by, which makes the tag joinable with the routing config.
        using var trace = TraceScope
            .Start("agent.run", "ai.agent")
            .SetTag("agent.name", input.FeatureTag);

        var sw = Stopwatch.StartNew();
        var steps = new List<AgentStep>();
        var messages = new List<LlmMessage> { new("user", input.UserGoal) };
        var toolSchemas = tools.SchemasFor(input.AllowedTools);
        var toolCtx = new ToolContext(ctx.UserId, ctx.EditionId, ctx.AgentRunId, ctx.Services);

        int inputTokens = 0, outputTokens = 0;
        decimal cost = 0m;
        string? modelId = null;

        // Local so every terminal path (success, cost cap, MaxSteps) reports the same numbers the
        // AgentRun row gets — no prompt or answer text, only counters.
        void Measure(int iterations)
        {
            trace.SetTag("agent.model", modelId)
                .SetMeasure("agent.iterations", iterations)
                .SetMeasure("agent.tokens_in", inputTokens)
                .SetMeasure("agent.tokens_out", outputTokens)
                .SetMeasure("agent.cost_usd", (double)cost)
                .SetMeasure("agent.duration_ms", sw.ElapsedMilliseconds);
        }

        for (var iteration = 0; iteration < options.MaxSteps; iteration++)
        {
            ct.ThrowIfCancellationRequested();

            var request = new LlmRequest(
                input.SystemPrompt, messages, options.MaxTokensPerStep,
                Tools: toolSchemas.Count > 0 ? toolSchemas : null, FeatureTag: input.FeatureTag);

            var response = await llm.CompleteAsync(request, ct);
            inputTokens += response.Usage.InputTokens;
            outputTokens += response.Usage.OutputTokens;
            cost += response.Usage.CostUsd;
            modelId = response.ModelId;

            var llmStep = Step(iteration, "llm_response", SerializeResponse(response));
            steps.Add(llmStep);
            yield return AgentEvent.OfStep(llmStep);

            // No tool calls → the model has produced its final answer.
            if (response.ToolCalls.Count == 0)
            {
                sw.Stop();
                trace.Outcome = TraceScope.OutcomeCompleted;
                Measure(iteration + 1);
                yield return AgentEvent.Done(new AgentResult<string>(
                    response.Text, steps,
                    new AgentUsage(iteration + 1, inputTokens, outputTokens, cost, (int)sw.ElapsedMilliseconds)));
                yield break;
            }

            // The assistant's tool-call turn must precede the tool results (OpenAI message ordering).
            messages.Add(new LlmMessage("assistant", response.Text, response.ToolCalls));

            var results = await dispatcher.DispatchAllAsync(response.ToolCalls, toolCtx, ct);
            for (var j = 0; j < response.ToolCalls.Count; j++)
            {
                var call = response.ToolCalls[j];
                var result = results[j];
                var toolStep = Step(iteration, "tool_result", SerializeResult(call, result));
                steps.Add(toolStep);
                yield return AgentEvent.OfStep(toolStep);
                // Errors come back as data (ToolCallingSession serialization) so the model can recover.
                messages.Add(new LlmMessage("tool", ToolCallingSession.SerializeResult(result), [call]));
            }

            // Cost cap is checked AFTER the step completes, so a useful partial transcript is kept.
            if (options.CostCapUsd is { } cap && cost >= cap)
            {
                trace.Outcome = TraceScope.OutcomeBudgetExhausted;
                Measure(iteration + 1);
                throw new AgentBudgetExhaustedException(
                    $"Agent cost cap ${cap} exceeded after {iteration + 1} iteration(s) (${cost}).",
                    steps,
                    new AgentUsage(iteration + 1, inputTokens, outputTokens, cost, (int)sw.ElapsedMilliseconds));
            }
        }

        trace.Outcome = TraceScope.OutcomeBudgetExhausted;
        Measure(options.MaxSteps);
        throw new AgentBudgetExhaustedException(
            $"Agent reached MaxSteps={options.MaxSteps} without a final answer.",
            steps,
            new AgentUsage(options.MaxSteps, inputTokens, outputTokens, cost, (int)sw.ElapsedMilliseconds));
    }

    private static AgentStep Step(int iteration, string kind, JsonElement payload) =>
        new(iteration, kind, payload, DateTimeOffset.UtcNow);

    /// <summary>Compact JSON view of one model turn for the step transcript (text + requested calls).</summary>
    private static JsonElement SerializeResponse(LlmResponse response) =>
        JsonSerializer.SerializeToElement(new
        {
            text = response.Text,
            toolCalls = response.ToolCalls.Select(c => new { name = c.ToolName, args = c.Arguments }),
        });

    /// <summary>Compact JSON view of one tool outcome for the step transcript.</summary>
    private static JsonElement SerializeResult(ToolCall call, ToolResult result) =>
        JsonSerializer.SerializeToElement(new
        {
            tool = call.ToolName,
            args = call.Arguments,
            ok = result.Ok,
            result = result.Result,
            error = result.Error,
        });
}
