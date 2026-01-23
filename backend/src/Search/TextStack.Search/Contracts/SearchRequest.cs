using TextStack.Search.Enums;

namespace TextStack.Search.Contracts;

public sealed record SearchRequest(
    string Query,
    Guid SiteId,
    SearchLanguage Language = SearchLanguage.Auto,
    int Offset = 0,
    int Limit = 20,
    bool IncludeHighlights = false,
    IReadOnlyDictionary<string, string>? Filters = null
);
