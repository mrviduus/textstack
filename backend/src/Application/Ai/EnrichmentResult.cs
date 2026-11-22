using System.Text.Json;
using System.Text.Json.Serialization;

namespace Application.Ai;

/// <summary>What the enrichment agent was asked to produce metadata for.</summary>
public record EnrichmentInput(string Title, string? Author, string? Excerpt, bool NeedsDescription);

/// <summary>
/// One enriched field: the committed value, where it came from (<c>model</c> | <c>open_library</c> |
/// <c>reconciled</c> | <c>unknown</c>) and a calibrated 0–1 confidence. A field the agent could not
/// honestly determine is emitted as <see cref="Value"/> = null, source <c>unknown</c>, confidence ≈ 0 —
/// a deliberate "I don't know" rather than a hallucinated guess.
/// </summary>
public record EnrichedField<T>(T? Value, string Source, double Confidence);

/// <summary>
/// Structured output of the <see cref="EnrichmentAgent"/>: genre / year / description, each with its own
/// provenance + confidence, plus the overall confidence the loop used as its stopping signal and the list
/// of sources it consulted. Maps to <c>UserBook</c>'s metadata + provenance columns and to the legacy
/// <c>BookMetadataResult</c> the worker callers already expect.
/// </summary>
public record EnrichmentResult(
    EnrichedField<string> Genre,
    EnrichedField<int?> Year,
    EnrichedField<string> Description,
    double OverallConfidence,
    IReadOnlyList<string> Sources)
{
    /// <summary>Serializes the per-field provenance to the jsonb shape persisted on <c>UserBook</c>.</summary>
    public string ToProvenanceJson() => JsonSerializer.Serialize(new
    {
        genre = Field(Genre),
        year = Field(Year),
        description = Field(Description),
        sources = Sources,
    });

    private static object Field<T>(EnrichedField<T> f) => new { value = f.Value, source = f.Source, confidence = f.Confidence };

    /// <summary>An all-unknown result (used when the agent errors or budget-exhausts before any commit).</summary>
    public static EnrichmentResult Unknown { get; } = new(
        new EnrichedField<string>(null, SourceUnknown, 0),
        new EnrichedField<int?>(null, SourceUnknown, 0),
        new EnrichedField<string>(null, SourceUnknown, 0),
        0,
        []);

    public const string SourceModel = "model";
    public const string SourceOpenLibrary = "open_library";
    public const string SourceReconciled = "reconciled";
    public const string SourceUnknown = "unknown";
}

/// <summary>
/// The JSON contract the agent's final message must emit (parsed by <see cref="EnrichmentResult"/> mapping).
/// Lenient: any missing/low-confidence field is treated as unknown. Year 0 / negative ⇒ unknown.
/// </summary>
public record EnrichmentJson(
    [property: JsonPropertyName("genre")] string? Genre,
    [property: JsonPropertyName("genreConfidence")] double GenreConfidence,
    [property: JsonPropertyName("year")] int? Year,
    [property: JsonPropertyName("yearConfidence")] double YearConfidence,
    [property: JsonPropertyName("description")] string? Description,
    [property: JsonPropertyName("descriptionConfidence")] double DescriptionConfidence,
    [property: JsonPropertyName("genreSource")] string? GenreSource,
    [property: JsonPropertyName("yearSource")] string? YearSource,
    [property: JsonPropertyName("descriptionSource")] string? DescriptionSource,
    [property: JsonPropertyName("sources")] List<string>? Sources);
