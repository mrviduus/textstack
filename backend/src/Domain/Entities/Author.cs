namespace Domain.Entities;

public class Author
{
    public Guid Id { get; set; }
    public Guid SiteId { get; set; }
    public required string Slug { get; set; }
    public required string Name { get; set; }
    public string? Bio { get; set; }
    public string? PhotoPath { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    // SEO fields
    public bool Indexable { get; set; } = true;
    public string? SeoTitle { get; set; }
    public string? SeoDescription { get; set; }
    public string? CanonicalOverride { get; set; }

    // SEO content blocks
    public string? SeoRelevanceText { get; set; }
    public string? SeoThemesJson { get; set; }
    public string? SeoFaqsJson { get; set; }

    public Site Site { get; set; } = null!;
    public ICollection<EditionAuthor> EditionAuthors { get; set; } = [];
}
