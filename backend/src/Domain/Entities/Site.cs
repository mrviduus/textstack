namespace Domain.Entities;

public class Site
{
    public Guid Id { get; set; }
    public required string Code { get; set; }
    public required string PrimaryDomain { get; set; }
    public required string DefaultLanguage { get; set; }
    public string Theme { get; set; } = "default";
    public bool AdsEnabled { get; set; }
    public bool IndexingEnabled { get; set; }
    public bool SitemapEnabled { get; set; } = true;
    public string FeaturesJson { get; set; } = "{}";
    public int MaxWordsPerPart { get; set; } = 2000;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public ICollection<SiteDomain> Domains { get; set; } = [];
    public ICollection<Work> Works { get; set; } = [];
}
