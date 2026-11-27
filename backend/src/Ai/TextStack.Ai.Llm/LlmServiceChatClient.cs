using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;
using TextStack.Ai.Core;

namespace TextStack.Ai.Llm;

/// <summary>
/// Adapts our <see cref="ILlmService"/> seam to Microsoft.Extensions.AI's
/// <see cref="IChatClient"/> so MEAI evaluators (built-in + custom) call the SAME
/// OpenAI gateway we use in prod — no new external service. Maps
/// <see cref="ChatMessage"/>s → <see cref="LlmRequest"/> (system messages collapse
/// into <see cref="LlmRequest.SystemPrompt"/>, the rest become <see cref="LlmMessage"/>s)
/// and <see cref="LlmResponse"/> → <see cref="ChatResponse"/>.
///
/// <para><see cref="LlmRequest.FeatureTag"/> drives routing/tracing in our gateway.
/// It comes from <see cref="ChatOptions.AdditionalProperties"/>["FeatureTag"] when set,
/// else <paramref name="defaultFeatureTag"/> — so one judge adapter can tag
/// <c>eval.judge</c> while a generation adapter tags its feature.</para>
/// </summary>
public sealed class LlmServiceChatClient(
    ILlmService inner,
    string? defaultFeatureTag = null,
    int defaultMaxOutputTokens = 1000) : IChatClient
{
    /// <summary>Key under which a caller may stash the FeatureTag in <see cref="ChatOptions.AdditionalProperties"/>.</summary>
    public const string FeatureTagKey = "FeatureTag";

    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var resp = await inner.CompleteAsync(ToLlmRequest(messages, options), cancellationToken);

        return new ChatResponse(new ChatMessage(ChatRole.Assistant, resp.Text))
        {
            ResponseId = resp.TraceId.ToString(),
            ModelId = resp.ModelId,
            FinishReason = ChatFinishReason.Stop,
            Usage = new UsageDetails
            {
                InputTokenCount = resp.Usage.InputTokens,
                OutputTokenCount = resp.Usage.OutputTokens,
            },
        };
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var delta in inner.StreamAsync(ToLlmRequest(messages, options), cancellationToken))
        {
            if (delta.TextDelta is { Length: > 0 } text)
                yield return new ChatResponseUpdate(ChatRole.Assistant, text);
        }
    }

    /// <summary>No backing service to expose; returns <c>this</c> when asked for an <see cref="IChatClient"/>.</summary>
    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType.IsInstanceOfType(this) ? this : null;

    public void Dispose() { /* inner is not owned by the adapter */ }

    private LlmRequest ToLlmRequest(IEnumerable<ChatMessage> messages, ChatOptions? options)
    {
        var system = new List<string>();
        var rest = new List<LlmMessage>();
        foreach (var m in messages)
        {
            if (m.Role == ChatRole.System)
                system.Add(m.Text);
            else
                rest.Add(new LlmMessage(m.Role.Value, m.Text));
        }

        var featureTag = options?.AdditionalProperties is { } props
            && props.TryGetValue(FeatureTagKey, out var tag) && tag is string s
                ? s
                : defaultFeatureTag;

        return new LlmRequest(
            SystemPrompt: string.Join("\n\n", system),
            Messages: rest,
            MaxOutputTokens: options?.MaxOutputTokens ?? defaultMaxOutputTokens,
            FeatureTag: featureTag);
    }
}
