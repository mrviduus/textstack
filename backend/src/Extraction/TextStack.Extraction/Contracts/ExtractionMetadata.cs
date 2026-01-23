namespace TextStack.Extraction.Contracts;

public sealed record ExtractionMetadata(
    string? Title,
    string? Authors,
    string? Language,
    string? Description,
    byte[]? CoverImage = null,
    string? CoverMimeType = null
);
