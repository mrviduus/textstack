namespace TextStack.Ai.Llm;

/// <summary>
/// The provider keys that have a keyed <c>ILlmService</c> registration. Single source of truth so a
/// readiness probe can tell "typo in Ai:Routes" from "a provider we know how to check".
///
/// This list used to be duplicated: an inline array in <c>Application.DependencyInjection</c> and a
/// hardcoded set in the Worker's startup check. They drifted — the startup check omitted
/// <c>openai-pdf</c> and so silently skipped validating the most expensive route in the system.
/// </summary>
public static class AiProviderKeys
{
    public const string Ollama = "ollama";

    /// <summary>Prefix shared by every OpenAI-family key. Matching on the prefix (rather than an
    /// enumerated set) is what stops the next added key from being silently unvalidated.</summary>
    public const string OpenAiPrefix = "openai";

    public static readonly string[] Registered =
    [
        "openai", "ollama", "openai-judge", "openai-explain",
    ];
}
