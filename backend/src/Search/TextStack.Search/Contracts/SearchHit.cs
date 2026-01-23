namespace TextStack.Search.Contracts;

public sealed record SearchHit(
    string DocumentId,
    double Score,
    IReadOnlyList<Highlight> Highlights,
    IReadOnlyDictionary<string, object> Metadata
)
{
    public static SearchHit Create(string documentId, double score) =>
        new(documentId, score, [], new Dictionary<string, object>());

    public static SearchHit Create(string documentId, double score, IReadOnlyDictionary<string, object> metadata) =>
        new(documentId, score, [], metadata);
}
