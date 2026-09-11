using System.Text.Json;
using TextStack.Vocabulary.Contracts;

namespace TextStack.Vocabulary;

/// <summary>
/// The four choices behind every multiple-choice card: the word itself plus three distractors,
/// shuffled, with the index of the right one.
///
/// <para>Extracted because <see cref="ReviewCardBuilder"/> carried two copies of it — one for
/// <c>multiple_choice</c> and one for <c>context</c> — and because the Tutor now needs the same
/// options for its own cards. Three copies of a rule that decides what a learner is shown is how the
/// copies start to disagree.</para>
///
/// <para>The distractor cascade is deliberate and ordered by how much the distractor knows about the
/// word: the LLM's own distractors first (generated at save time, semantically near), then other
/// words from the learner's vocabulary in the same language, then a hardcoded per-language list. The
/// last one exists so a card is never short of options — a three-option card would tell the learner
/// something about the answer.</para>
/// </summary>
public static class McOptions
{
    /// <summary>Options per card: the answer plus three distractors.</summary>
    public const int Choices = 4;

    private const int Distractors = Choices - 1;

    public static (List<string> Options, int CorrectIndex) Build(
        string word,
        string language,
        string? distractorsJson,
        IReadOnlyList<DistractorPoolEntry> pool)
    {
        var chosen = new List<string>(Distractors);

        void Take(IEnumerable<string> candidates)
        {
            foreach (var candidate in candidates)
            {
                if (chosen.Count >= Distractors) return;
                if (string.IsNullOrWhiteSpace(candidate)) continue;
                // Never the answer itself, and never twice: either would make one option provably
                // wrong or provably right without knowing the word.
                if (candidate.Equals(word, StringComparison.OrdinalIgnoreCase)) continue;
                if (chosen.Any(c => c.Equals(candidate, StringComparison.OrdinalIgnoreCase))) continue;
                chosen.Add(candidate);
            }
        }

        var llm = ParseDistractors(distractorsJson);
        if (llm is { Count: >= Distractors })
            Take(llm.OrderBy(_ => Random.Shared.Next()));

        if (chosen.Count < Distractors)
            Take(pool.Where(d => d.Language == language).Select(d => d.Word).OrderBy(_ => Random.Shared.Next()));

        if (chosen.Count < Distractors)
            Take(DistractorWords.ForLanguage(language).OrderBy(_ => Random.Shared.Next()));

        var options = chosen.Append(word).OrderBy(_ => Random.Shared.Next()).ToList();
        return (options, options.IndexOf(word));
    }

    /// <summary>
    /// The LLM's distractors, or null. A single letter or a string with no letters is dropped — those
    /// are generation noise, and as an option they read as a bug rather than as a wrong answer.
    /// </summary>
    public static List<string>? ParseDistractors(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            var list = JsonSerializer.Deserialize<List<string>>(json);
            return list?.Where(w => w.Length > 1 && w.Any(char.IsLetter)).ToList();
        }
        catch { return null; }
    }
}
