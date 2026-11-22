using Domain.LLM;

namespace Application.Ai;

/// <summary>
/// Bridges the legacy <see cref="ILlmService"/> (string in / string out) onto the
/// new <c>TextStack.Ai.Core.ILlmService</c> stack (ModelGateway → TracingDecorator →
/// provider). One adapter is created per job by <see cref="LlmServiceFactory"/>,
/// carrying the <paramref name="featureTag"/> the gateway routes/traces on.
///
/// Lets the 5 existing callers keep using the legacy interface unchanged while
/// the call actually flows through the new (traced, routed) stack. The legacy
/// interface + this adapter are deleted once callers move to Core directly.
/// Core types are written global:: to avoid the Application.* namespace clash.
/// </summary>
public sealed class LegacyLlmAdapter(global::TextStack.Ai.Core.ILlmService gateway, string featureTag) : ILlmService
{
    public async Task<string> CompleteAsync(string systemPrompt, string userPrompt, int maxOutputTokens, CancellationToken ct)
    {
        var request = new global::TextStack.Ai.Core.LlmRequest(
            SystemPrompt: systemPrompt,
            Messages: [new global::TextStack.Ai.Core.LlmMessage("user", userPrompt)],
            MaxOutputTokens: maxOutputTokens,
            FeatureTag: featureTag);

        var response = await gateway.CompleteAsync(request, ct);
        return response.Text;
    }
}
