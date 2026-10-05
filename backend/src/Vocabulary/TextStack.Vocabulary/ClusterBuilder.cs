using System.Net.Http.Json;
using Domain.Utilities;
using Microsoft.Extensions.Options;

namespace TextStack.Vocabulary;

public sealed class ClusterBuilder : IClusterBuilder
{
    private const double CohesionThreshold = 0.7;

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly VocabularyOptions _options;

    public ClusterBuilder(IHttpClientFactory httpClientFactory, IOptions<VocabularyOptions> options)
    {
        _httpClientFactory = httpClientFactory;
        _options = options.Value;
    }

    public async Task<ClusterCandidate?> BuildAsync(
        IReadOnlyList<(Guid Id, string Word)> words,
        string? bookTitle,
        string nativeLanguage,
        CancellationToken ct)
    {
        if (words.Count < 5) return null;

        try
        {
            var prompt = BuildPrompt(words.Select(w => w.Word).ToList(), bookTitle, nativeLanguage);
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(_options.OllamaTimeoutSeconds);

            var request = new { model = _options.OllamaModel, prompt, stream = false };
            var response = await client.PostAsJsonAsync($"{_options.OllamaBaseUrl}/api/generate", request, ct);
            if (!response.IsSuccessStatusCode) return null;

            var result = await response.Content.ReadFromJsonAsync<OllamaResponse>(ct);
            if (string.IsNullOrWhiteSpace(result?.Response)) return null;

            return Parse(result.Response, words);
        }
        catch
        {
            return null;
        }
    }

    public async Task<ClusterLabel?> LabelAsync(
        IReadOnlyList<string> words,
        string nativeLanguage,
        CancellationToken ct)
    {
        if (words.Count == 0) return null;

        try
        {
            var prompt = BuildLabelPrompt(words, nativeLanguage);
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(_options.OllamaTimeoutSeconds);

            var request = new { model = _options.OllamaModel, prompt, stream = false };
            var response = await client.PostAsJsonAsync($"{_options.OllamaBaseUrl}/api/generate", request, ct);
            if (!response.IsSuccessStatusCode) return null;

            var result = await response.Content.ReadFromJsonAsync<OllamaResponse>(ct);
            if (string.IsNullOrWhiteSpace(result?.Response)) return null;

            return ParseLabel(result.Response);
        }
        catch
        {
            return null;
        }
    }

    private static string BuildLabelPrompt(IReadOnlyList<string> words, string nativeLanguage)
    {
        // Label-only: the words ALREADY form one group (membership fixed upstream). No scoring,
        // no member selection — just name the shared theme.
        var parts = new List<string>
        {
            "You name vocabulary groups.",
            "",
            "The following words have already been grouped together because they share meaning.",
            "Give the group one short, descriptive name.",
            "",
            $"Words: {string.Join(", ", words)}",
            "",
            $"Title must be short (max 8 words), in {LanguageNames.ToEnglishName(nativeLanguage)}, describing the shared theme.",
            "Theme must be a single lowercase slug (e.g. 'finance', 'emotions', 'warfare').",
            "",
            "Reply in this EXACT format (no other text):",
            "THEME: slug",
            "TITLE: human readable title",
        };

        return string.Join("\n", parts);
    }

    private static ClusterLabel? ParseLabel(string raw)
    {
        string? theme = null;
        string? title = null;

        foreach (var line in raw.Split('\n', StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith("THEME:", StringComparison.OrdinalIgnoreCase))
                theme = line["THEME:".Length..].Trim().ToLowerInvariant();
            else if (line.StartsWith("TITLE:", StringComparison.OrdinalIgnoreCase))
                title = line["TITLE:".Length..].Trim();
        }

        if (string.IsNullOrWhiteSpace(title)) return null;

        return new ClusterLabel(
            Title: title.Length > 200 ? title[..200] : title,
            Theme: string.IsNullOrWhiteSpace(theme) ? null : (theme.Length > 100 ? theme[..100] : theme));
    }

    private static string BuildPrompt(List<string> words, string? bookTitle, string nativeLanguage)
    {
        var parts = new List<string>
        {
            "You analyze vocabulary lists for thematic cohesion.",
            "",
            "Given a set of words a reader saved, decide if they form one clear theme.",
            "",
            $"Words: {string.Join(", ", words)}",
        };

        if (!string.IsNullOrWhiteSpace(bookTitle))
            parts.Add($"Source book: \"{bookTitle}\"");

        parts.Add("");
        parts.Add("Scoring rules:");
        parts.Add("- 0.0-0.6: words have no meaningful shared theme — reject.");
        parts.Add("- 0.7-0.9: words clearly share one domain (e.g. finance, emotions, warfare, cooking).");
        parts.Add("- 1.0: all words are near-synonyms or same narrow concept.");
        parts.Add("");
        parts.Add($"Title must be short (max 8 words), in {LanguageNames.ToEnglishName(nativeLanguage)}, describing the theme.");
        parts.Add("Theme must be a single lowercase slug (e.g. 'finance', 'emotions', 'warfare').");
        parts.Add("");
        parts.Add("Reply in this EXACT format (no other text):");
        parts.Add("SCORE: 0.0-1.0");
        parts.Add("THEME: slug");
        parts.Add("TITLE: human readable title");
        parts.Add("MEMBERS: word1, word2, word3 (only the words that fit the theme, at least 3)");

        return string.Join("\n", parts);
    }

    private static ClusterCandidate? Parse(string raw, IReadOnlyList<(Guid Id, string Word)> words)
    {
        double? score = null;
        string? theme = null;
        string? title = null;
        string? membersLine = null;

        foreach (var line in raw.Split('\n', StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith("SCORE:", StringComparison.OrdinalIgnoreCase))
            {
                var v = line["SCORE:".Length..].Trim();
                if (double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
                    score = parsed;
            }
            else if (line.StartsWith("THEME:", StringComparison.OrdinalIgnoreCase))
                theme = line["THEME:".Length..].Trim().ToLowerInvariant();
            else if (line.StartsWith("TITLE:", StringComparison.OrdinalIgnoreCase))
                title = line["TITLE:".Length..].Trim();
            else if (line.StartsWith("MEMBERS:", StringComparison.OrdinalIgnoreCase))
                membersLine = line["MEMBERS:".Length..].Trim();
        }

        if (score is null || score < CohesionThreshold) return null;
        if (string.IsNullOrWhiteSpace(title)) return null;

        var memberWords = membersLine?
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(m => m.ToLowerInvariant())
            .ToHashSet() ?? [];

        // Resolve word IDs by literal match (case-insensitive). Require ≥3 matches.
        var matchedIds = words
            .Where(w => memberWords.Count == 0 || memberWords.Contains(w.Word.ToLowerInvariant()))
            .Select(w => w.Id)
            .ToList();

        if (matchedIds.Count < 3) return null;

        return new ClusterCandidate(
            Title: title.Length > 200 ? title[..200] : title,
            Theme: string.IsNullOrWhiteSpace(theme) ? null : (theme.Length > 100 ? theme[..100] : theme),
            CohesionScore: score.Value,
            MemberWordIds: matchedIds);
    }
}

file class OllamaResponse
{
    public string Response { get; set; } = "";
}
