using Domain.LLM;

namespace Application.Ai;

/// <summary>
/// The Explain feature's prompt, extracted from <c>Api.Endpoints.ExplainEndpoints</c>
/// so the eval harness (TextStack.Ai.Evals) exercises the SAME prompt production
/// serves — a copy would let the two drift. Pure string building, no dependencies.
/// </summary>
public static class ExplainPrompt
{
    /// <summary>Part of the answer cache key. Bump on any prompt change that should reach cached answers.</summary>
    public const int Version = 2;

    public static string BuildSystemPrompt(string? genre, string targetLang)
    {
        var domain = string.IsNullOrWhiteSpace(genre) ? "general" : genre.Trim();
        return
            $"You explain unfamiliar words or phrases to a reader in context. " +
            $"Domain hint: {domain}. " +
            $"Respond in {LanguageNames.ToEnglishName(targetLang)}. " +
            "Write 2-3 sentences. Focus on how the word is used IN THIS SENTENCE, " +
            "not a dictionary definition. If it is a technical term, give the meaning and " +
            "one concrete analogy. No preface, no quotes around the answer, no markdown.";
    }

    public static string BuildUserPrompt(string word, string sentence) =>
        $"Word: {word}\nSentence: {sentence}";
}
