using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using OpenAI;
using OpenAI.Chat;
using TextStack.Ai.Core;

namespace TextStack.Ai.Llm;

/// <summary>
/// OpenAI provider for the new <see cref="ILlmService"/> seam. Ported 1:1 from
/// Application/LLM/OpenAiLlmService.cs — DO NOT "clean up" the reasoning-budget
/// padding. Stateless and thread-safe (ChatClient is thread-safe); registered
/// as a singleton in AI-005.
/// </summary>
public sealed class OpenAiLlmClient : ILlmService
{
    private readonly ChatClient _client;
    private readonly string _model;
    private readonly int _reasoningBudget;
    private readonly ILogger<OpenAiLlmClient> _logger;

    public OpenAiLlmClient(IConfiguration config, ILogger<OpenAiLlmClient> logger, string? modelOverride = null)
    {
        _logger = logger;

        // Treat an empty/whitespace value as "not configured" — otherwise an empty
        // string flows into the OpenAI SDK and surfaces as a cryptic
        // "Value cannot be an empty string. (Parameter 'key')" deep in the call stack
        // (this exact trap cost a debugging session when the worker lacked the key).
        var apiKey = config["OpenAI:ApiKey"];
        if (string.IsNullOrWhiteSpace(apiKey))
            apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey))
            throw new InvalidOperationException("OPENAI_API_KEY not configured (OpenAI:ApiKey / OPENAI_API_KEY is empty)");

        // modelOverride lets a second instance (e.g. the eval judge) run a different,
        // stronger model than the default generation model — without it every OpenAI
        // caller is pinned to OpenAI:Model.
        _model = modelOverride
            ?? config["OpenAI:Model"]
            ?? Environment.GetEnvironmentVariable("OPENAI_MODEL")
            ?? "gpt-4.1-nano";

        // Reasoning models (gpt-5, o1, o3…) spend tokens on internal reasoning
        // before visible output. MaxOutputTokenCount caps the COMBINED total, so
        // we pad the caller's budget with a reserve. Non-reasoning models just
        // get a harmless higher ceiling. (Verbatim from the legacy service.)
        _reasoningBudget = int.TryParse(config["OpenAI:ReasoningTokenBudget"], out var rb) ? rb : 512;

        _client = new OpenAIClient(apiKey).GetChatClient(_model);
    }

    private static List<ChatMessage> BuildMessages(LlmRequest request)
    {
        var messages = new List<ChatMessage> { new SystemChatMessage(request.SystemPrompt) };
        foreach (var m in request.Messages)
        {
            messages.Add(m.Role.ToLowerInvariant() switch
            {
                // An assistant turn that requested tool calls (function-calling round 2 sends the
                // model its own calls back, then the tool results below).
                "assistant" when m.ToolCalls is { Count: > 0 } =>
                    new AssistantChatMessage(m.ToolCalls.Select(ToChatToolCall)),
                "assistant" => new AssistantChatMessage(m.Content),
                // A tool result: Content is the tool's JSON output; ToolCalls[0] carries the call id.
                "tool" => new ToolChatMessage(
                    m.ToolCalls is { Count: > 0 }
                        ? m.ToolCalls[0].Id
                        : throw new InvalidOperationException("A 'tool' message must carry its ToolCall (for the call id)."),
                    m.Content),
                "system" => new SystemChatMessage(m.Content),
                _ => new UserChatMessage(m.Content),
            });
        }
        return messages;
    }

    private ChatCompletionOptions BuildOptions(LlmRequest request)
    {
        var options = new ChatCompletionOptions
        {
            MaxOutputTokenCount = request.MaxOutputTokens + _reasoningBudget, // +512 padding quirk
        };
        if (request.Tools is { Count: > 0 })
        {
            foreach (var tool in request.Tools)
            {
                options.Tools.Add(ChatTool.CreateFunctionTool(
                    tool.Name, tool.Description, BinaryData.FromString(tool.ArgsSchema.GetRawText())));
            }
        }
        return options;
    }

    private static ChatToolCall ToChatToolCall(ToolCall call) =>
        ChatToolCall.CreateFunctionToolCall(call.Id, call.ToolName, BinaryData.FromString(call.Arguments.GetRawText()));

    /// <summary>Parses a function-call's arguments JSON ("" → empty object) into a detached element.</summary>
    private static JsonElement ParseArgs(string argumentsJson)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(argumentsJson) ? "{}" : argumentsJson);
        return doc.RootElement.Clone();
    }

    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        var messages = BuildMessages(request);
        var options = BuildOptions(request);

        var result = await _client.CompleteChatAsync(messages, options, ct);
        var completion = result.Value;

        var toolCalls = completion.ToolCalls
            .Select(tc => new ToolCall(tc.Id, tc.FunctionName, ParseArgs(tc.FunctionArguments.ToString())))
            .ToList();

        var text = completion.Content.FirstOrDefault()?.Text ?? string.Empty;
        // Empty content is normal on a tool-call turn — only warn when the model produced nothing at all.
        if (string.IsNullOrWhiteSpace(text) && toolCalls.Count == 0)
        {
            _logger.LogWarning(
                "OpenAI returned empty content (finish={Finish}, maxOutputTokens={Max})",
                completion.FinishReason, options.MaxOutputTokenCount);
        }

        var inputTokens = completion.Usage?.InputTokenCount ?? 0;
        var outputTokens = completion.Usage?.OutputTokenCount ?? 0;
        if (!ModelPricing.IsPriced(_model))
            _logger.LogWarning("No pricing entry for OpenAI model {Model}; cost recorded as 0", _model);

        var usage = new LlmUsage(inputTokens, outputTokens, ModelPricing.CostUsd(_model, inputTokens, outputTokens));

        return new LlmResponse(text.Trim(), toolCalls, usage, _model, Guid.NewGuid());
    }

    public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var messages = BuildMessages(request);
        var options = BuildOptions(request);

        // Real token streaming: yield each content fragment as it arrives. Tool calls stream as
        // fragments (id/name on the first update for an index, then argument chunks) — accumulate per
        // index and emit each COMPLETE call as a ToolCallDelta after the provider stream ends (partial
        // tool-call streaming is out of Phase 5 scope). The SDK surfaces token usage on the final
        // update; if absent, usage falls back to 0 — text + latency are still traced.
        ChatTokenUsage? usage = null;
        var pendingCalls = new SortedDictionary<int, (string Id, string Name, StringBuilder Args)>();

        await foreach (var update in _client.CompleteChatStreamingAsync(messages, options, ct))
        {
            foreach (var part in update.ContentUpdate)
            {
                if (!string.IsNullOrEmpty(part.Text))
                    yield return new LlmDelta(TextDelta: part.Text);
            }
            foreach (var tc in update.ToolCallUpdates)
            {
                if (!pendingCalls.TryGetValue(tc.Index, out var entry))
                    pendingCalls[tc.Index] = entry = (tc.ToolCallId ?? string.Empty, tc.FunctionName ?? string.Empty, new StringBuilder());
                if (!string.IsNullOrEmpty(tc.ToolCallId) && entry.Id.Length == 0)
                    pendingCalls[tc.Index] = entry = (tc.ToolCallId, entry.Name, entry.Args);
                if (!string.IsNullOrEmpty(tc.FunctionName) && entry.Name.Length == 0)
                    pendingCalls[tc.Index] = entry = (entry.Id, tc.FunctionName, entry.Args);
                // Guard ToMemory().IsEmpty like the SDK's own streaming example: a fragment's
                // arguments BinaryData can be empty/degenerate on the first (id+name) chunk, and
                // ToString() on such instances has thrown ("Parameter 'bytes'") on prod.
                if (tc.FunctionArgumentsUpdate is not null && !tc.FunctionArgumentsUpdate.ToMemory().IsEmpty)
                    entry.Args.Append(tc.FunctionArgumentsUpdate.ToString());
            }
            if (update.Usage is not null)
                usage = update.Usage;
        }

        foreach (var (_, call) in pendingCalls)
            yield return new LlmDelta(ToolCallDelta: new ToolCall(call.Id, call.Name, ParseArgs(call.Args.ToString())));

        var inputTokens = usage?.InputTokenCount ?? 0;
        var outputTokens = usage?.OutputTokenCount ?? 0;
        if (!ModelPricing.IsPriced(_model))
            _logger.LogWarning("No pricing entry for OpenAI model {Model}; cost recorded as 0", _model);

        yield return new LlmDelta(
            FinalUsage: new LlmUsage(inputTokens, outputTokens, ModelPricing.CostUsd(_model, inputTokens, outputTokens)),
            ModelId: _model);
    }
}
