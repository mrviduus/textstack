using System.Text.Json;
using Domain.LLM;

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
        var langLabel = string.IsNullOrWhiteSpace(userLang) ? "English" : userLang;

        var prompt =
            $"Suggest 3 to 5 short tags (single word or short hyphenated phrase, lowercase) " +
            $"for the book below. Tags should describe genre, themes, audience, or notable " +
            $"characteristics. Output a JSON array of strings only.\n\n" +
            $"Title: \"{title}\"\n" +
            (string.IsNullOrWhiteSpace(author) ? string.Empty : $"Author: \"{author}\"\n") +
            (string.IsNullOrWhiteSpace(language) ? string.Empty : $"Book language: {language}\n") +
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

    private static string? ExtractJsonArray(string raw)
    {
        var start = raw.IndexOf('[');
        var end = raw.LastIndexOf(']');
        if (start < 0 || end <= start) return null;
        return raw.Substring(start, end - start + 1);
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
