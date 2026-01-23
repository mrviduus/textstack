using TextStack.Search.Abstractions;
using TextStack.Search.Enums;

namespace TextStack.Search.Analyzers;

public sealed class MultilingualAnalyzer : ITextAnalyzer
{
    public string Normalize(string text) => TextNormalizer.Normalize(text);

    public IReadOnlyList<string> Tokenize(string text) => TextNormalizer.Tokenize(text);

    public string GetFtsConfig(SearchLanguage language) => language switch
    {
        SearchLanguage.En => "english",
        SearchLanguage.Uk => "simple",  // Ukrainian: no stemming available in PostgreSQL by default
        SearchLanguage.Auto => "simple",
        _ => "simple"
    };

    public string StripHtml(string html) => TextNormalizer.StripHtml(html);

    /// <summary>
    /// Detects language from ISO code string.
    /// </summary>
    public static SearchLanguage DetectFromCode(string? languageCode)
    {
        if (string.IsNullOrEmpty(languageCode))
            return SearchLanguage.Auto;

        return languageCode.ToLowerInvariant() switch
        {
            "en" => SearchLanguage.En,
            "eng" => SearchLanguage.En,
            "english" => SearchLanguage.En,
            "uk" => SearchLanguage.Uk,
            "ukr" => SearchLanguage.Uk,
            "ukrainian" => SearchLanguage.Uk,
            _ => SearchLanguage.Auto
        };
    }
}
