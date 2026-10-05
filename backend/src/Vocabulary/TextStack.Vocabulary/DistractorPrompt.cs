using Domain.Utilities;

namespace TextStack.Vocabulary;

/// <summary>
/// The vocabulary-quiz prompt (distractors + hint + explanation) extracted from
/// <see cref="DistractorGenerator"/> so the eval harness exercises the SAME prompt
/// production serves. One call produces all three facets in a fixed line format.
/// Pure string building, no dependencies.
/// </summary>
public static class DistractorPrompt
{
    public static (string System, string User) Build(
        string word, string language, string? definition, string? sentence, string nativeLanguage)
    {
        // Models follow a language NAME ("Ukrainian"); a bare code ("uk") gets English back.
        var languageName = LanguageNames.ToEnglishName(language);
        var nativeName = LanguageNames.ToEnglishName(nativeLanguage);

        var system = "You generate vocabulary quiz data for language learners. " +
                     "Always reply in the EXACT format requested. No preface, no markdown.";

        var parts = new List<string>
        {
            $"Word: \"{word}\"",
        };

        if (!string.IsNullOrWhiteSpace(definition))
            parts.Add($"Definition: \"{definition}\"");
        if (!string.IsNullOrWhiteSpace(sentence))
            parts.Add($"Context: \"{sentence}\"");

        parts.Add($"Language: {languageName}");
        parts.Add("");
        parts.Add("Task 1 - Distractors: Generate 5 wrong-answer words that:");
        parts.Add($"- Same part of speech as \"{word}\"");
        parts.Add("- Similar difficulty level");
        parts.Add("- NOT synonyms");
        parts.Add("- Could plausibly confuse a learner");
        // No example words here: small models copy them into the distractors.
        parts.Add("- SINGLE WORD ONLY — no spaces, no multi-word phrases. Hyphens are fine.");
        parts.Add("");
        parts.Add("Task 2 - Hint: Write ONE short sentence (under 15 words) describing what this word means.");
        parts.Add($"Do NOT use the word \"{word}\" or direct synonyms in the hint.");
        parts.Add("");
        parts.Add($"Task 3 - Explanation: Write 2-3 sentences in {nativeName} explaining the meaning of \"{word}\".");
        if (!string.IsNullOrWhiteSpace(sentence))
            parts.Add($"Include how it is used in this context: \"{sentence}\"");
        parts.Add("");
        parts.Add("Reply in this EXACT format (no other text):");
        parts.Add("DISTRACTORS: word1, word2, word3, word4, word5");
        parts.Add("HINT: your hint sentence here");
        parts.Add("EXPLANATION: your explanation here");

        return (system, string.Join("\n", parts));
    }
}
