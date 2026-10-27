namespace TextStack.Ai.Core;

/// <summary>
/// The single seam through which every LLM call in TextStack flows. Tracing, routing, retries,
/// and escalation are decorators/composition on top — never sprinkled in callers.
/// </summary>
public interface ILlmService
{
    /// <summary>Issues a one-shot completion and returns the full response.</summary>
    Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct);

    /// <summary>Streams the response as deltas (text chunks and/or tool-call fragments).</summary>
    IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct);
}
