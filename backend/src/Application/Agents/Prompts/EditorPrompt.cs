using Domain.Utilities;

namespace Application.Agents.Prompts;

/// <summary>
/// The crew editor's prompt (AI-041): rewrite the draft fixing each issue the critic raised, blockers first,
/// while keeping the facts the draft got right and staying within the brief's character bounds. Reads length
/// and banned phrases from the SAME <see cref="BriefConstraints"/> the drafter and critic use, so a rewrite
/// can't satisfy the editor yet fail the critic on length. Pure string building.
/// </summary>
public static class EditorPrompt
{
    public static string BuildSystemPrompt(ContentBrief brief)
    {
        var prompt =
            $"You are an editor revising a draft {brief.FieldName} for a {brief.EntityType}. " +
            "Rewrite the draft to fix every issue listed in the critique, addressing the \"blocker\" issues first, " +
            "then \"major\", then \"minor\". " +
            "Keep the facts the draft already got right; remove or correct any claim flagged as unsupported. " +
            $"Write in {LanguageNames.ToEnglishName(brief.TargetLanguage)}. " +
            $"The revised text must be {BriefConstraints.Length(brief)} long.";

        if (BriefConstraints.BannedPhrases(brief) is { } banned)
            prompt += $" Do not use these phrases: {banned}.";

        prompt += " Output only the revised text — no markdown, no preface, no commentary.";
        return prompt;
    }

    public static string BuildUserPrompt(Draft draft, CritiqueResult critique)
    {
        var issues = critique.Issues.Count == 0
            ? "(no specific issues listed)"
            : string.Join("\n", critique.Issues.Select(i => $"- [{i.Severity}] {i.Location}: {i.Fix}"));

        return $"Draft to revise:\n{draft.Text}\n\nIssues to fix:\n{issues}";
    }
}
