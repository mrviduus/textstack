namespace TextStack.Ai.Llm;

/// <summary>
/// The provider keys that have a keyed <c>ILlmService</c> registration (<c>Application.DependencyInjection</c>).
/// </summary>
public static class AiProviderKeys
{
    public static readonly string[] Registered =
    [
        "openai", "openai-judge", "openai-explain",
    ];
}
