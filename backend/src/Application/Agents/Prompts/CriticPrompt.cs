using Domain.Utilities;

namespace Application.Agents.Prompts;

/// <summary>
/// The crew critic's prompt (AI-041) — the most load-bearing prompt in the crew. It scores the draft 1-5 on
/// four axes AGAINST THE RESEARCH NOTES (not the model's own knowledge): any draft claim not supported by the
/// notes is a factual-accuracy <c>blocker</c>. That research-grounding is the whole point — it turns "does
/// this sound plausible?" into "is this actually in the source?", which is what makes the critic catch
/// hallucinations the drafter slipped in. The output MUST be a bare JSON object matching the exact schema
/// <see cref="CriticOutputParser"/> deserializes; the parser fails closed on anything else. Pure strings.
/// </summary>
public static class CriticPrompt
{
    /// <summary>The literal schema the critic must emit and <see cref="CriticOutputParser"/> parses — kept in one place.</summary>
    public const string Schema =
        "{\"scores\":{\"factual_accuracy\":1-5,\"tone\":1-5,\"length\":1-5,\"banned_phrases\":1-5}," +
        "\"issues\":[{\"location\":\"…\",\"severity\":\"blocker|major|minor\",\"fix\":\"…\"}]}";

    public static string BuildSystemPrompt(ContentBrief brief)
    {
        var prompt =
            $"You are an editor reviewing a draft {brief.FieldName} for a {brief.EntityType}. " +
            "Score the draft 1-5 (1 worst, 5 best) on each of four axes:\n" +
            "- factual_accuracy: every claim in the draft must be supported BY THE RESEARCH NOTES. " +
            "Flag EVERY claim that is not supported by the notes as a \"blocker\" issue and lower this score.\n" +
            $"- tone: does it match the requested style{(string.IsNullOrWhiteSpace(brief.StyleGuide) ? string.Empty : $" ({brief.StyleGuide!.Trim()})")} " +
            $"and read naturally in {LanguageNames.ToEnglishName(brief.TargetLanguage)}?\n" +
            $"- length: is the draft within {BriefConstraints.Length(brief)}?\n" +
            "- banned_phrases: does the draft avoid the banned phrases?";

        if (BriefConstraints.BannedPhrases(brief) is { } banned)
            prompt += $" Banned phrases: {banned}.";

        prompt +=
            "\nList every concrete problem as an issue with a location, a severity " +
            "(\"blocker\", \"major\", or \"minor\"), and a specific fix.\n" +
            "Output a bare JSON object ONLY — no markdown, no code fences, no commentary before or after it — " +
            "with EXACTLY this schema:\n" + Schema;

        return prompt;
    }

    public static string BuildUserPrompt(Draft draft, ResearchNotes research) =>
        $"Research notes:\n{research.Notes}\n\nDraft to review:\n{draft.Text}";
}
