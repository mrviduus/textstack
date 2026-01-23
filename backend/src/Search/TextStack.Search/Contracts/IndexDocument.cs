using TextStack.Search.Enums;

namespace TextStack.Search.Contracts;

public sealed record IndexDocument(
    string Id,
    string Title,
    string Content,
    SearchLanguage Language,
    Guid SiteId,
    IReadOnlyDictionary<string, object>? Metadata = null
)
{
    public static IndexDocument Create(string id, string title, string content, SearchLanguage language, Guid siteId) =>
        new(id, title, content, language, siteId, null);
}
