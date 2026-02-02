using Domain.Enums;

namespace Domain.Entities;

public class Edition
{
    public Guid Id { get; set; }
    public Guid WorkId { get; set; }
    public Guid SiteId { get; set; }
    public required string Language { get; set; }
    public required string Slug { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public EditionStatus Status { get; set; }
    public DateTimeOffset? PublishedAt { get; set; }
    public Guid? SourceEditionId { get; set; }
    public string? CoverPath { get; set; }
    public bool IsPublicDomain { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    // SEO fields
    public bool Indexable { get; set; } = true;
    public string? SeoTitle { get; set; }
    public string? SeoDescription { get; set; }
    public string? CanonicalOverride { get; set; }

    // SEO content blocks (override auto-generated)
    public string? SeoRelevanceText { get; set; }
    public string? SeoThemesJson { get; set; }  // JSON array: ["Theme1", "Theme2"]
    public string? SeoFaqsJson { get; set; }    // JSON array: [{q: "", a: ""}, ...]

    // Table of contents (JSON)
    public string? TocJson { get; set; }

    public Work Work { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition? SourceEdition { get; set; }
    public ICollection<Edition> TranslatedEditions { get; set; } = [];
    public ICollection<Chapter> Chapters { get; set; } = [];
    public ICollection<BookFile> BookFiles { get; set; } = [];
    public ICollection<IngestionJob> IngestionJobs { get; set; } = [];
    public ICollection<EditionAuthor> EditionAuthors { get; set; } = [];
    public ICollection<Genre> Genres { get; set; } = [];
    public ICollection<BookAsset> Assets { get; set; } = [];
}
