using System.Text.Json;
using Domain.LLM;
using Domain.Utilities;

namespace Worker.Services;

public class TagSuggestionGenerator : ITagSuggestionGenerator
{
    private readonly ILlmServiceFactory _llmFactory;

    public TagSuggestionGenerator(ILlmServiceFactory llmFactory)
    {
        _llmFactory = llmFactory;
    }

    public const int MaxTags = 5;
    public const int MinTagLength = 1;
    public const int MaxTagLength = 30;
    private const int ExcerptWordCount = 200;

    public async Task<string[]> GenerateAsync(
        string title, string? author, string? language, string? excerpt,
        string? userNativeLanguage, CancellationToken ct)
    {
        var (system, user) = BuildPrompt(title, author, language, excerpt, userNativeLanguage);

        var llm = _llmFactory.Get("TagSuggestion");
        var raw = await llm.CompleteAsync(system, user, maxOutputTokens: 200, ct);
        if (string.IsNullOrWhiteSpace(raw)) return Array.Empty<string>();

        return ParseAndValidate(raw);
    }

    private static (string System, string User) BuildPrompt(
        string title, string? author, string? language, string? excerpt, string? userLang)
    {
        var system = "You are a librarian. Suggest concise tags for a book. " +
                     "Return ONLY a JSON array of lowercase strings — no preface, no markdown.";

        var truncated = TruncateToWords(excerpt ?? string.Empty, ExcerptWordCount);
        var langLabel = string.IsNullOrWhiteSpace(userLang) ? "English" : LanguageNames.ToEnglishName(userLang);

        var prompt =
            $"Suggest 3 to 5 short tags (single word or short hyphenated phrase, lowercase) " +
            $"for the book below. Tags should describe genre, themes, audience, or notable " +
            $"characteristics. Output a JSON array of strings only.\n\n" +
            $"Title: \"{title}\"\n" +
            (string.IsNullOrWhiteSpace(author) ? string.Empty : $"Author: \"{author}\"\n") +
            (string.IsNullOrWhiteSpace(language) ? string.Empty : $"Book language: {LanguageNames.ToEnglishName(language)}\n") +
            (string.IsNullOrWhiteSpace(truncated) ? string.Empty : $"First chapter excerpt: \"{truncated}\"\n") +
            $"\nTags must be in {langLabel}.";

        return (system, prompt);
    }

    internal static string TruncateToWords(string s, int maxWords)
    {
        if (string.IsNullOrEmpty(s)) return string.Empty;
        var words = s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return words.Length <= maxWords ? s : string.Join(' ', words.Take(maxWords));
    }

    public static string[] ParseAndValidate(string raw)
    {
        var json = ExtractJsonArray(raw);
        if (json is null) return Array.Empty<string>();

        try
        {
            var arr = JsonSerializer.Deserialize<string[]>(json);
            if (arr is null) return Array.Empty<string>();
            return arr
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .Select(Normalize)
                .Where(IsValid)
                .Distinct()
                .Take(MaxTags)
                .ToArray();
        }
        catch (JsonException)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// The first complete, bracket-balanced JSON array in <paramref name="raw"/>. Brackets inside
    /// strings (and escaped quotes) don't count, so a model that repeats the array, or writes
    /// prose with a "]" after it, still yields just the first one.
    /// </summary>
    internal static string? ExtractJsonArray(string raw)
    {
        var start = raw.IndexOf('[');
        if (start < 0) return null;

        var depth = 0;
        var inString = false;
        for (var i = start; i < raw.Length; i++)
        {
            var c = raw[i];
            if (inString)
            {
                if (c == '\\') i++;
                else if (c == '"') inString = false;
            }
            else if (c == '"') inString = true;
            else if (c == '[') depth++;
            else if (c == ']' && --depth == 0) return raw[start..(i + 1)];
        }
        return null;
    }

    private static string Normalize(string tag)
    {
        var lowered = tag.Trim().ToLowerInvariant();
        var collapsed = System.Text.RegularExpressions.Regex.Replace(lowered, @"\s+", "-");
        return new string(collapsed.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
    }

    private static bool IsValid(string tag)
        => tag.Length >= MinTagLength && tag.Length <= MaxTagLength;
}

public interface ITagSuggestionGenerator
{
    Task<string[]> GenerateAsync(
        string title, string? author, string? language, string? excerpt,
        string? userNativeLanguage, CancellationToken ct);
}
