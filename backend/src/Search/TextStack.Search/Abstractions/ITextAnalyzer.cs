using TextStack.Search.Enums;

namespace TextStack.Search.Abstractions;

public interface ITextAnalyzer
{
    string Normalize(string text);

    IReadOnlyList<string> Tokenize(string text);

    string GetFtsConfig(SearchLanguage language);

    string StripHtml(string html);
}
