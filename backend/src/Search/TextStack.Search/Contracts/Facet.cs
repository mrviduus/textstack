namespace TextStack.Search.Contracts;

public sealed record Facet(
    string Name,
    IReadOnlyList<FacetValue> Values
);

public sealed record FacetValue(
    string Value,
    int Count
);
