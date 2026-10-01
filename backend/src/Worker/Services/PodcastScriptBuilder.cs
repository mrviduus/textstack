using System.Text.Json;
using Application.Ai;
using Application.Common.Interfaces;
using Domain.LLM;
using Microsoft.EntityFrameworkCore;

namespace Worker.Services;

public interface IPodcastScriptBuilder
{
    /// <summary>Build a 2-voice dialogue script for an edition, or null if the edition
    /// is missing / the LLM returns nothing usable.</summary>
    Task<PodcastScript?> BuildAsync(Guid editionId, string lang, CancellationToken ct);
}

public record DialogueLine(string Speaker, string Line);

public record PodcastScript(IReadOnlyList<DialogueLine> Lines);

/// <summary>
/// Builds the podcast dialogue (Phase 3, AI-012): loads an edition's chapters, fits
/// them into a word budget, prompts the gateway (FeatureTag <c>podcast.script</c> →
/// gpt-4.1-nano) for a strict-JSON Aria/Guy dialogue, and parses it. The JSON parse
/// is a public static so it can be unit-tested without the LLM. Audio assembly +
/// worker wiring follow in AI-013/AI-014.
/// </summary>
public class PodcastScriptBuilder(IAppDbContext db, ILlmServiceFactory llmFactory) : IPodcastScriptBuilder
{
    // Intro is anchored on the Description; the excerpt is just a short secondary
    // anchor (and a safety net for titles the model doesn't know), not the whole book.
    private const int MaxExcerptWords = 800;

    private static readonly HashSet<string> Hosts = new(StringComparer.OrdinalIgnoreCase) { "Aria", "Guy" };

    public async Task<PodcastScript?> BuildAsync(Guid editionId, string lang, CancellationToken ct)
    {
        var edition = await db.Editions
            .Where(e => e.Id == editionId)
            .Select(e => new
            {
                e.Title,
                e.Language,
                e.Description,
                Author = e.EditionAuthors.OrderBy(a => a.Order).Select(a => a.Author.Name).FirstOrDefault(),
                Chapters = e.Chapters.OrderBy(c => c.ChapterNumber).Select(c => c.PlainText).ToList(),
            })
            .FirstOrDefaultAsync(ct);
        if (edition is null)
            return null;

        var excerpt = TagSuggestionGenerator.TruncateToWords(string.Join("\n\n", edition.Chapters), MaxExcerptWords);
        // Need at least one anchor — the curated overview or some opening text.
        if (string.IsNullOrWhiteSpace(edition.Description) && string.IsNullOrWhiteSpace(excerpt))
            return null;

        var language = string.IsNullOrWhiteSpace(lang) ? edition.Language : lang;
        var (system, user) = PodcastPrompt.Build(edition.Title, edition.Author, language, edition.Description, excerpt);

        var llm = llmFactory.Get("PodcastScript");
        var raw = await llm.CompleteAsync(system, user, maxOutputTokens: 4000, ct);
        if (string.IsNullOrWhiteSpace(raw))
            return null;

        var lines = ParseScript(raw);
        return lines is { Count: > 0 } ? new PodcastScript(lines) : null;
    }

    /// <summary>Robustly parse the LLM output into Aria/Guy turns; null if unusable.</summary>
    public static IReadOnlyList<DialogueLine>? ParseScript(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;

        // LLMs sometimes wrap the array in prose/code fences — grab the first [...] span.
        var start = raw.IndexOf('[');
        var end = raw.LastIndexOf(']');
        if (start < 0 || end <= start)
            return null;

        try
        {
            var parsed = JsonSerializer.Deserialize<List<DialogueLine>>(
                raw[start..(end + 1)],
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (parsed is null)
                return null;

            var cleaned = parsed
                .Where(l => l is not null
                    && !string.IsNullOrWhiteSpace(l.Speaker)
                    && !string.IsNullOrWhiteSpace(l.Line)
                    && Hosts.Contains(l.Speaker.Trim()))
                .Select(l => new DialogueLine(CanonicalHost(l.Speaker), l.Line.Trim()))
                .ToList();

            return cleaned.Count > 0 ? cleaned : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string CanonicalHost(string speaker) =>
        speaker.Trim().Equals("Aria", StringComparison.OrdinalIgnoreCase) ? "Aria" : "Guy";
}
