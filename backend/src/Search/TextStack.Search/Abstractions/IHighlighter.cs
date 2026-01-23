using TextStack.Search.Contracts;

namespace TextStack.Search.Abstractions;

public interface IHighlighter
{
    IReadOnlyList<Highlight> GetHighlights(
        string content,
        string query,
        string field = "content",
        int maxFragments = 3,
        int fragmentSize = 150);
}
