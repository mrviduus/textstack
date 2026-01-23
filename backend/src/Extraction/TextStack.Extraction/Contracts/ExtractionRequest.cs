namespace TextStack.Extraction.Contracts;

public sealed class ExtractionRequest
{
    public required Stream Content { get; init; }
    public required string FileName { get; init; }
    public string? MimeType { get; init; }
    public long? ContentLength { get; init; }
    public ExtractionOptions Options { get; init; } = ExtractionOptions.Default;
}
