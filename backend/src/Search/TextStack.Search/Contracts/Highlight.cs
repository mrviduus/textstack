namespace TextStack.Search.Contracts;

public sealed record Highlight(
    string Field,
    IReadOnlyList<string> Fragments
)
{
    public static Highlight Create(string field, params string[] fragments) =>
        new(field, fragments);
}
