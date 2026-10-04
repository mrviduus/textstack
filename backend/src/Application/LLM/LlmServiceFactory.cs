using Domain.LLM;

namespace Application.LLM;

/// <summary>
/// Resolves an <see cref="ILlmService"/> per job. As of AI-005 every job is
/// served by a <see cref="LegacyLlmAdapter"/> over the new
/// <c>TextStack.Ai.Core.ILlmService</c> (ModelGateway) — provider selection now
/// lives in <c>Ai:Routes</c> (keyed by FeatureTag), not <c>LLM:Providers</c>.
/// </summary>
public class LlmServiceFactory(global::TextStack.Ai.Core.ILlmService gateway) : ILlmServiceFactory
{
    // Legacy job name → new FeatureTag (matches appsettings Ai:Routes keys).
    private static readonly Dictionary<string, string> FeatureTags = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Explain"] = "explain",
        ["Translate"] = "translate",
        ["Distractor"] = "distractor",
        ["BookMetadata"] = "bookmeta",
        ["TagSuggestion"] = "tagsuggestion",
    };

    public ILlmService Get(string jobName)
    {
        var featureTag = FeatureTags.TryGetValue(jobName, out var tag) ? tag : jobName.ToLowerInvariant();
        return new LegacyLlmAdapter(gateway, featureTag);
    }
}
