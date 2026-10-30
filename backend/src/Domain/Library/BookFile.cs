namespace Domain.Library;

/// <summary>
/// One exact file version of a <see cref="Book"/> (V2 table <c>book_files</c>). At most one per book
/// is current; a replaced version keeps its row as provenance for what was anchored in it.
/// </summary>
public class BookFile
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }

    /// <summary>Lowercase hex SHA-256 of the bytes: duplicate detection, per owner.</summary>
    public string Sha256 { get; set; } = "";

    public long ByteSize { get; set; }
    public string OriginalName { get; set; } = "";

    /// <summary><c>epub</c>, <c>pdf</c> or <c>html</c> (a clipped web page).</summary>
    public string Format { get; set; } = "";

    public int? PageCount { get; set; }

    /// <summary>Opaque JSON.</summary>
    public string? Toc { get; set; }

    /// <summary>Relative key of the bytes on the volume; null when the server holds none.</summary>
    public string? ServerStorageKey { get; set; }

    public bool IsCurrent { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
