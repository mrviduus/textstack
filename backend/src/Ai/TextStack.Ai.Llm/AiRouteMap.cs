using Microsoft.Extensions.Configuration;

namespace TextStack.Ai.Llm;

/// <summary>How a provider's reachability can be established without spending money.</summary>
public enum ProviderProbeKind
{
    /// <summary>Cheap HTTP GET against the local model server.</summary>
    OllamaHttp,

    /// <summary>Config-only: an API key is present. Never spend tokens to prove a paid provider is up.</summary>
    OpenAiKey,

    /// <summary>A key named in Ai:Routes that has no registration — almost certainly a typo.</summary>
    Unknown,
}

/// <summary>
/// Reads the route table straight off <see cref="IConfiguration"/> so startup code can answer
/// "which providers does this host actually depend on, and which tasks break if one is down?".
///
/// Re-implements <c>ModelGateway</c>'s config precedence. Runtime routing is unaffected — the gateway
/// remains the only thing that actually routes a call.
/// </summary>
public static class AiRouteMap
{
    /// <summary>Synthetic tag standing in for <c>Ai:DefaultProvider</c> — every unrouted feature lands there.</summary>
    public const string DefaultProviderTag = "(default)";

    public const string FallbackProviderKey = "openai";

    /// <summary>
    /// providerKey → feature tags routed to it, both ordered ordinally for stable log output.
    /// Skips the <c>_</c>-prefixed documentation keys the appsettings files use for comments.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Build(IConfiguration config)
    {
        var byProvider = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

        void Add(string providerKey, string featureTag)
        {
            if (!byProvider.TryGetValue(providerKey, out var tags))
                byProvider[providerKey] = tags = [];
            tags.Add(featureTag);
        }

        foreach (var route in config.GetSection("Ai:Routes").GetChildren())
        {
            if (route.Key.StartsWith('_') || string.IsNullOrWhiteSpace(route.Value))
                continue;
            Add(route.Value.Trim(), route.Key);
        }

        var defaultProvider = config["Ai:DefaultProvider"];
        if (!string.IsNullOrWhiteSpace(defaultProvider))
            Add(defaultProvider.Trim(), DefaultProviderTag);

        return byProvider.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<string>)kv.Value.OrderBy(t => t, StringComparer.Ordinal).ToList(),
            StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// <c>Ai:Routes:{tag}</c> → <c>Ai:DefaultProvider</c> → <c>"openai"</c>. Mirrors
    /// <c>ModelGateway.ResolveRoute</c>.
    /// </summary>
    public static string ResolveProviderKey(IConfiguration config, string? featureTag)
    {
        var routed = !string.IsNullOrWhiteSpace(featureTag) ? config[$"Ai:Routes:{featureTag}"] : null;
        if (!string.IsNullOrWhiteSpace(routed))
            return routed.Trim();

        var fallback = config["Ai:DefaultProvider"];
        return string.IsNullOrWhiteSpace(fallback) ? FallbackProviderKey : fallback.Trim();
    }

    /// <summary>Prefix rule, not an enumerated set — a newly added <c>openai-*</c> key is classified
    /// automatically instead of being silently skipped, which is how the previous check drifted.</summary>
    public static ProviderProbeKind ProbeKindFor(string providerKey)
    {
        if (string.Equals(providerKey, AiProviderKeys.Ollama, StringComparison.OrdinalIgnoreCase))
            return ProviderProbeKind.OllamaHttp;

        return providerKey.StartsWith(AiProviderKeys.OpenAiPrefix, StringComparison.OrdinalIgnoreCase)
            ? ProviderProbeKind.OpenAiKey
            : ProviderProbeKind.Unknown;
    }

    /// <summary>Operator-facing one-liner: <c>"bookmeta, distractor, tagsuggestion → ollama (unreachable)"</c>.</summary>
    public static string FormatUnreachable(string providerKey, IReadOnlyList<string> featureTags, string state) =>
        $"{string.Join(", ", featureTags)} → {providerKey} ({state})";
}
