using TextStack.Search.Enums;

namespace TextStack.Search.Abstractions;

public interface IQueryBuilder
{
    string BuildQuery(string userQuery, SearchLanguage language);

    string BuildPrefixQuery(string prefix);

    string GetLanguageConfig(SearchLanguage language);
}
