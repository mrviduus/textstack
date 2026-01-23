namespace TextStack.Search.Contracts;

public sealed record Suggestion(
    string Text,
    string Slug,
    string? Authors,
    string? CoverPath,
    double Score
);
