using Domain.Enums;

namespace Domain.Entities;

/// <summary>
/// Editable Claude prompt template for generating a single SEO field on a given entity type + language.
/// Templates are versioned: editing creates a new active row and archives the previous.
/// Jobs reference a template + version for immutable replay.
/// </summary>
public class SeoTemplate
{
    public Guid Id { get; set; }

    public SeoEntityType EntityType { get; set; }
    public SeoFieldType FieldType { get; set; }

    /// <summary>ISO 639-1, e.g. "en".</summary>
    public string LanguageCode { get; set; } = "en";

    public required string Name { get; set; }
    public string? Description { get; set; }

    /// <summary>
    /// Prompt text with <c>{placeholder}</c> tokens resolved by <c>SeoTemplateRenderer</c>.
    /// Supported placeholders depend on EntityType (e.g. author: {name}, {books}; edition: {title}, {author}, {excerpt}).
    /// </summary>
    public required string PromptTemplate { get; set; }

    /// <summary>
    /// JSON schema describing the expected Claude response shape. Validator enforces it with 3 retries on failure.
    /// </summary>
    public required string OutputSchema { get; set; }

    public string Model { get; set; } = "claude-sonnet-4-6";
    public int MaxTokens { get; set; } = 4096;
    public double Temperature { get; set; } = 0.7;

    public SeoTrustLevel TrustLevel { get; set; } = SeoTrustLevel.Review;

    public int Version { get; set; } = 1;
    public bool IsActive { get; set; } = true;

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
