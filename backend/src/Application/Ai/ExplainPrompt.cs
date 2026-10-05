using Domain.Utilities;

namespace Application.Ai;

/// <summary>
/// The Explain feature's prompt, extracted from <c>Api.Endpoints.ExplainEndpoints</c>
/// so the eval harness (TextStack.Ai.Evals) exercises the SAME prompt production
/// serves — a copy would let the two drift. Pure string building, no dependencies.
/// </summary>
public static class ExplainPrompt
{
    public static string BuildSystemPrompt(string? genre, string targetLang, bool withTools = false)
    {
        var domain = string.IsNullOrWhiteSpace(genre) ? "general" : genre.Trim();
        var prompt =
            $"You explain unfamiliar words or phrases to a reader in context. " +
            $"Domain hint: {domain}. " +
            $"Respond in {LanguageNames.ToEnglishName(targetLang)}. " +
            "Write 2-3 sentences. Focus on how the word is used IN THIS SENTENCE, " +
            "not a dictionary definition. If it is a technical term, give the meaning and " +
            "one concrete analogy. No preface, no quotes around the answer, no markdown.";

        // Phase 5 function-calling (AI-031b): appended only when the request actually carries tools.
        // Iterated against the AI-033 eval (0.33 → 0.50 → 0.73 → …): v1 made nano call the dictionary
        // on every word; v2's "RARELY needed" framing over-corrected into under-calling. v3 keys each
        // tool to an explicit LEXICAL trigger in the sentence (chapter number / "earlier-before" /
        // "my highlights") with imperative ALWAYS, and keeps the no-signal → no-tool default.
        // lookup_dictionary was dropped from the Explain set entirely (circular for this audience).
        if (withTools)
        {
            prompt +=
                "\n\nYou have access to tools. Whether to call one depends ONLY on the sentence's wording, " +
                "never on the word being explained:\n" +
                "- The sentence mentions a chapter NUMBER (\"Chapter 5\", \"see Chapter 9\", \"Chapter 11 turns to\") " +
                "-> ALWAYS call get_chapter with that number.\n" +
                "- The sentence mentions the user's own highlights, notes, or things they marked/saved " +
                "-> ALWAYS call get_user_highlights.\n" +
                "If the sentence contains NONE of these signals, do NOT call any tool - answer directly from the " +
                "sentence; a word being technical or unfamiliar is never by itself a reason to call a tool. " +
                "After using tools, give the same 2-3 sentence explanation, citing tool results when used.";
        }

        return prompt;
    }

    public static string BuildUserPrompt(string word, string sentence) =>
        $"Word: {word}\nSentence: {sentence}";
}
