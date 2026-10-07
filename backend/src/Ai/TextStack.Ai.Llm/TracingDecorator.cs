using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Observability;

namespace TextStack.Ai.Llm;

/// <summary>
/// Wraps any <see cref="ILlmService"/> and records a sampled <see cref="LlmTrace"/>
/// per call (cost/latency/tokens/error). Singleton: the trace write is
/// fire-and-forget on a fresh DI scope (IServiceScopeFactory → scoped
/// ILlmTraceWriter), so persistence never adds latency to the LLM call.
///
/// Cost is taken from <c>response.Usage.CostUsd</c> (computed by the provider via
/// ModelPricing in AI-002) — the decorator does not recompute it.
/// </summary>
public sealed class TracingDecorator(
    ILlmService inner,
    IServiceScopeFactory scopeFactory,
    TracingOptions options,
    ILogger<TracingDecorator> logger,
    string providerKey = "unknown") : ILlmService
{
    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var response = await inner.CompleteAsync(request, ct);
            sw.Stop();
            TryPersist(BuildTrace(request, response, sw.ElapsedMilliseconds, error: null), isError: false);
            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Caller abandoned the call (e.g. the HTTP client disconnected) — not a model error.
            // Recording it would pollute the dashboard's error rate, so rethrow untraced.
            throw;
        }
        catch (Exception ex)
        {
            sw.Stop();
            TryPersist(BuildTrace(request, response: null, sw.ElapsedMilliseconds, error: ex.Message), isError: true);
            // The one choke point every provider exception passes through (cancellation excluded
            // above), so Sentry sees OpenAI outages/timeouts with the task + provider already tagged.
            LlmFailureAlarm.Capture(providerKey, request.FeatureTag, LlmFailureAlarm.ReasonException, ex);
            throw;
        }
    }

    // Streamed calls are traced like one-shot ones (AI-028): accumulate the text deltas + terminal
    // usage/model, then persist one trace when the stream ends (or errors mid-flight). Re-yields every
    // delta unchanged so the caller still streams in real time.
    public async IAsyncEnumerable<LlmDelta> StreamAsync(
        LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var text = new StringBuilder();
        var toolCalls = new List<ToolCall>();
        LlmUsage? usage = null;
        string? modelId = null;
        var traceId = Guid.NewGuid();

        await using var e = inner.StreamAsync(request, ct).GetAsyncEnumerator(ct);
        while (true)
        {
            LlmDelta delta;
            try
            {
                if (!await e.MoveNextAsync())
                    break;
                delta = e.Current;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // SSE client disconnected (a normal end to a stream) — not a model error. Rethrow
                // untraced so a cancelled stream doesn't count against the dashboard's error rate.
                throw;
            }
            catch (Exception ex)
            {
                sw.Stop();
                TryPersist(
                    BuildTrace(request, BuildStreamedResponse(text.ToString(), toolCalls, usage, modelId, traceId),
                        sw.ElapsedMilliseconds, error: ex.Message),
                    isError: true);
                LlmFailureAlarm.Capture(providerKey, request.FeatureTag, LlmFailureAlarm.ReasonException, ex);
                throw;
            }

            if (delta.TextDelta is not null) text.Append(delta.TextDelta);
            if (delta.ToolCallDelta is not null) toolCalls.Add(delta.ToolCallDelta);
            if (delta.FinalUsage is not null) usage = delta.FinalUsage;
            if (delta.ModelId is not null) modelId = delta.ModelId;
            yield return delta;
        }

        sw.Stop();
        TryPersist(
            BuildTrace(request, BuildStreamedResponse(text.ToString(), toolCalls, usage, modelId, traceId),
                sw.ElapsedMilliseconds, error: null),
            isError: false);
    }

    /// <summary>Assembles the accumulated stream into an <see cref="LlmResponse"/> for tracing —
    /// including any tool calls the model streamed, so <c>tool_calls_json</c> is populated for
    /// streamed function-calling rounds exactly like one-shot ones (AI-031b). Usage/model default
    /// to the same "unknown"/zeros a failed one-shot call records.</summary>
    public static LlmResponse BuildStreamedResponse(
        string text, IReadOnlyList<ToolCall> toolCalls, LlmUsage? usage, string? modelId, Guid traceId) =>
        new(text, toolCalls, usage ?? new LlmUsage(0, 0, 0m), modelId ?? "unknown", traceId);

    private void TryPersist(LlmTrace trace, bool isError)
    {
        if (!ShouldSample(trace.FeatureTag, isError, options))
            return;

        // Fire-and-forget on its own scope — the decorator is a singleton but
        // ILlmTraceWriter (and its DbContext) is scoped.
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var writer = scope.ServiceProvider.GetRequiredService<ILlmTraceWriter>();
                await writer.WriteAsync(trace, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to persist LLM trace {TraceId} ({Feature})", trace.Id, trace.FeatureTag);
            }
        });
    }

    // ---- pure, deterministic helpers (unit-tested directly) ----

    /// <summary>Build a trace from a request/response (response null on error).</summary>
    public static LlmTrace BuildTrace(LlmRequest request, LlmResponse? response, long latencyMs, string? error)
    {
        var messagesJson = JsonSerializer.Serialize(request.Messages);
        var toolCallsJson = response is { ToolCalls.Count: > 0 }
            ? JsonSerializer.Serialize(response.ToolCalls)
            : null;

        return new LlmTrace(
            Id: response?.TraceId ?? Guid.NewGuid(),
            FeatureTag: string.IsNullOrWhiteSpace(request.FeatureTag) ? "unknown" : request.FeatureTag,
            ModelId: response?.ModelId ?? "unknown",
            PromptHash: ComputePromptHash(request.SystemPrompt, messagesJson),
            SystemPrompt: TraceRedactor.Redact(request.SystemPrompt),
            MessagesJson: TraceRedactor.Redact(messagesJson) ?? "[]",
            ResponseText: TraceRedactor.Redact(response?.Text),
            ToolCallsJson: TraceRedactor.StripNul(toolCallsJson),
            TokensIn: response?.Usage.InputTokens ?? 0,
            TokensOut: response?.Usage.OutputTokens ?? 0,
            CostUsd: response?.Usage.CostUsd ?? 0m,
            LatencyMs: (int)Math.Min(latencyMs, int.MaxValue),
            UserId: null,
            TraceParentId: request.TraceParentId,
            Error: error,
            CreatedAt: DateTimeOffset.UtcNow);
    }

    /// <summary>Errors are always sampled; otherwise by the per-feature rate.</summary>
    public static bool ShouldSample(string featureTag, bool isError, TracingOptions options)
    {
        if (isError) return true;
        var rate = options.RateFor(featureTag);
        if (rate >= 1.0) return true;
        if (rate <= 0.0) return false;
        return Random.Shared.NextDouble() < rate;
    }

    private static string ComputePromptHash(string systemPrompt, string messagesJson)
    {
        var bytes = Encoding.UTF8.GetBytes($"{systemPrompt}\n{messagesJson}");
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
