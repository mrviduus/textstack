using Domain.Utilities;

namespace Application.Agents.Prompts;

/// <summary>
/// The crew drafter's prompt (AI-041): write the requested field using ONLY the researcher's notes, within
/// the brief's character bounds, in the target language, avoiding banned phrases. Writing strictly from the
/// notes is what keeps the draft groundable — the critic later scores it against those same notes, so any
/// claim the drafter invents shows up as an unsupported blocker. Pure string building.
/// </summary>
public static class DrafterPrompt
{
    public static string BuildSystemPrompt(ContentBrief brief)
    {
        var prompt =
            $"You are a copywriter writing the {brief.FieldName} of a {brief.EntityType}. " +
            "Use ONLY the facts in the research notes provided — do not add any information that is not in the notes. " +
            $"Write the text in {LanguageNames.ToEnglishName(brief.TargetLanguage)}. " +
            $"The text must be {BriefConstraints.Length(brief)} long.";

        if (BriefConstraints.BannedPhrases(brief) is { } banned)
            prompt += $" Do not use these phrases: {banned}.";

        if (!string.IsNullOrWhiteSpace(brief.StyleGuide))
            prompt += $" Style guide: {brief.StyleGuide.Trim()}.";

        prompt += " Output only the finished text — no markdown, no preface, no quotes around it.";
        return prompt;
    }

    public static string BuildUserPrompt(ResearchNotes research) =>
        $"Research notes:\n{research.Notes}";
}
