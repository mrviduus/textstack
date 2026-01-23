namespace TextStack.Search.Contracts;

public sealed record SearchResult(
    IReadOnlyList<SearchHit> Hits,
    int TotalCount,
    IReadOnlyList<Facet> Facets,
    IReadOnlyList<Suggestion> Suggestions
)
{
    public static SearchResult Empty => new([], 0, [], []);

    public static SearchResult FromHits(IReadOnlyList<SearchHit> hits, int totalCount) =>
        new(hits, totalCount, [], []);
}
