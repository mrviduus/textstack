namespace TextStack.Ai.Core;

/// <summary>A request to <see cref="ILlmService"/>. <see cref="FeatureTag"/> drives routing, tracing and cost caps.</summary>
public record LlmRequest(
    string SystemPrompt,
    IReadOnlyList<LlmMessage> Messages,
    int MaxOutputTokens,
    IReadOnlyList<ToolSchema>? Tools = null,
    string? FeatureTag = null,
    Guid? TraceParentId = null,
    decimal? CostCapUsd = null);

/// <summary>A completed response from <see cref="ILlmService.CompleteAsync"/>.</summary>
public record LlmResponse(
    string Text,
    IReadOnlyList<ToolCall> ToolCalls,
    LlmUsage Usage,
    string ModelId,
    Guid TraceId);

/// <summary>Token + dollar usage summary for one call. Cost is computed inside the provider/gateway.</summary>
public record LlmUsage(int InputTokens, int OutputTokens, decimal CostUsd);

/// <summary>A single conversation message. <c>Role</c> is one of "system", "user", "assistant", "tool".</summary>
public record LlmMessage(
    string Role,
    string Content,
    IReadOnlyList<ToolCall>? ToolCalls = null);

/// <summary>
/// One streaming chunk from <see cref="ILlmService.StreamAsync"/>. A <see cref="TextDelta"/> carries a
/// partial text fragment, a <see cref="ToolCallDelta"/> a partial tool-call, or the terminal delta carries
/// <see cref="FinalUsage"/> + <see cref="ModelId"/> (the usage row that closes the stream). Text and tool
/// deltas are mutually exclusive; the terminal usage delta sets <see cref="FinalUsage"/> and
/// <see cref="ModelId"/> together so <c>TracingDecorator</c> can attribute the streamed call (AI-028).
/// </summary>
public record LlmDelta(
    string? TextDelta = null,
    ToolCall? ToolCallDelta = null,
    LlmUsage? FinalUsage = null,
    string? ModelId = null);
