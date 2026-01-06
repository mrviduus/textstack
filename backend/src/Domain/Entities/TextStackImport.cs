namespace Domain.Entities;

public class TextStackImport
{
    public Guid Id { get; set; }
    public Guid SiteId { get; set; }
    public required string Identifier { get; set; }
    public Guid EditionId { get; set; }
    public DateTimeOffset ImportedAt { get; set; }

    public Site Site { get; set; } = null!;
    public Edition Edition { get; set; } = null!;
}
