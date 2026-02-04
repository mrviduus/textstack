using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Api.Endpoints;

public static class DictionaryEndpoints
{
    public static void MapDictionaryEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/dictionary").WithTags("Dictionary");

        group.MapGet("/{lang}/{word}", LookupWord).WithName("LookupWord");
    }

    private static async Task<IResult> LookupWord(
        string lang,
        string word,
        IHttpClientFactory httpClientFactory,
        CancellationToken ct)
    {
        // Validate input
        if (string.IsNullOrWhiteSpace(word))
            return Results.BadRequest("Word is required");

        if (word.Length > 100)
            return Results.BadRequest("Word is too long");

        // Normalize language code
        var langCode = lang.ToLowerInvariant() switch
        {
            "en" or "english" => "en",
            "uk" or "ukrainian" => "uk",
            "ru" or "russian" => "ru",
            "de" or "german" => "de",
            "fr" or "french" => "fr",
            "es" or "spanish" => "es",
            "pl" or "polish" => "pl",
            _ => lang.ToLowerInvariant()
        };

        try
        {
            var client = httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);

            // Use Free Dictionary API (powered by Wiktionary)
            var apiUrl = $"https://api.dictionaryapi.dev/api/v2/entries/{langCode}/{Uri.EscapeDataString(word.Trim())}";
            var response = await client.GetAsync(apiUrl, ct);

            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                return Results.NotFound(new DictionaryErrorResponse($"No definition found for '{word}'"));
            }

            if (!response.IsSuccessStatusCode)
            {
                return Results.Problem(
                    detail: $"Dictionary service error: {response.StatusCode}",
                    statusCode: 502
                );
            }

            var entries = await response.Content.ReadFromJsonAsync<List<DictionaryApiEntry>>(ct);

            if (entries == null || entries.Count == 0)
            {
                return Results.NotFound(new DictionaryErrorResponse($"No definition found for '{word}'"));
            }

            // Transform to our response format
            var entry = entries[0];
            var result = new DictionaryResponse(
                Word: entry.Word ?? word,
                Phonetic: entry.Phonetics?.FirstOrDefault(p => !string.IsNullOrEmpty(p.Text))?.Text,
                Definitions: entry.Meanings?.Select(m => new DictionaryMeaning(
                    PartOfSpeech: m.PartOfSpeech ?? "unknown",
                    Definitions: m.Definitions?.Take(3).Select(d => new DictionaryDefinition(
                        Definition: d.Definition ?? "",
                        Example: d.Example
                    )).ToList() ?? []
                )).ToList() ?? []
            );

            return Results.Ok(result);
        }
        catch (TaskCanceledException)
        {
            return Results.Problem("Dictionary request timed out", statusCode: 504);
        }
        catch (HttpRequestException ex)
        {
            return Results.Problem(
                detail: $"Dictionary service unavailable: {ex.Message}",
                statusCode: 503
            );
        }
    }
}

// Response DTOs
public record DictionaryResponse(
    string Word,
    string? Phonetic,
    List<DictionaryMeaning> Definitions
);

public record DictionaryMeaning(
    string PartOfSpeech,
    List<DictionaryDefinition> Definitions
);

public record DictionaryDefinition(
    string Definition,
    string? Example
);

public record DictionaryErrorResponse(string Message);

// Free Dictionary API response types
file class DictionaryApiEntry
{
    [JsonPropertyName("word")]
    public string? Word { get; set; }

    [JsonPropertyName("phonetics")]
    public List<DictionaryApiPhonetic>? Phonetics { get; set; }

    [JsonPropertyName("meanings")]
    public List<DictionaryApiMeaning>? Meanings { get; set; }
}

file class DictionaryApiPhonetic
{
    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("audio")]
    public string? Audio { get; set; }
}

file class DictionaryApiMeaning
{
    [JsonPropertyName("partOfSpeech")]
    public string? PartOfSpeech { get; set; }

    [JsonPropertyName("definitions")]
    public List<DictionaryApiDefinition>? Definitions { get; set; }
}

file class DictionaryApiDefinition
{
    [JsonPropertyName("definition")]
    public string? Definition { get; set; }

    [JsonPropertyName("example")]
    public string? Example { get; set; }
}
