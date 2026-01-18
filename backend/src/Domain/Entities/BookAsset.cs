using Domain.Enums;

namespace Domain.Entities;

public class BookAsset
{
    public Guid Id { get; set; }
    public Guid EditionId { get; set; }
    public AssetKind Kind { get; set; }
    public required string OriginalPath { get; set; }
    public required string StoragePath { get; set; }
    public required string ContentType { get; set; }
    public long ByteSize { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public Edition Edition { get; set; } = null!;
}
