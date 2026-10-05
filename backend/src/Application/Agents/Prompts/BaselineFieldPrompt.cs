using Domain.Utilities;

namespace Application.Agents.Prompts;

/// <summary>
/// The single-call baseline's prompt (AI-046, FeatureTag <c>crew.baseline</c>): write the requested field
/// DIRECTLY from the raw source in ONE LLM call. The system prompt folds the brief's FULL contract — length
/// bounds, banned phrases, target language, style guide — the SAME constraints the crew enforces across its
/// four specialists. The point of the A/B eval is to isolate ORCHESTRATION: the baseline is held to the
/// identical contract, so any quality lift the crew shows comes from researcher→drafter→critic→editor, not
/// from a weaker rubric. Reuses <see cref="BriefConstraints"/> so length + banned phrases read identically to
/// the drafter/critic/editor. Pure string building.
/// </summary>
public static class BaselineFieldPrompt
{
    public static string BuildSystemPrompt(ContentBrief brief)
    {
        var prompt =
            $"You are a copywriter writing the {brief.FieldName} of a {brief.EntityType}. " +
            "Use ONLY the facts in the source material provided — do not add any information that is not in it. " +
            $"Write the text in {LanguageNames.ToEnglishName(brief.TargetLanguage)}. " +
            $"The text must be {BriefConstraints.Length(brief)} long.";

        if (BriefConstraints.BannedPhrases(brief) is { } banned)
            prompt += $" Do not use these phrases: {banned}.";

        if (!string.IsNullOrWhiteSpace(brief.StyleGuide))
            prompt += $" Style guide: {brief.StyleGuide.Trim()}.";

        prompt += " Output only the finished text — no markdown, no preface, no quotes around it.";
        return prompt;
    }

    public static string BuildUserPrompt(string sourceMaterial) =>
        $"Source material:\n{sourceMaterial}";
}
