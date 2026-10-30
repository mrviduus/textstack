namespace Domain.Library;

/// <summary>
/// A library entry of one user (V2 table <c>books</c>, ADR-031): an upload, a clip, or a catalog book
/// that has no file yet. Its id survives renames and file replacement; removal only sets
/// <see cref="RemovedAt"/>, so what hangs on the book keeps its provenance.
/// </summary>
public class Book
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Title { get; set; } = "";
    public string? Author { get; set; }
    public string? Language { get; set; }
    public string? Description { get; set; }
    public string? Genre { get; set; }
    public int? PublishedYear { get; set; }
    public string[] Tags { get; set; } = [];

    /// <summary>Relative key of the cover on the volume, not a path.</summary>
    public string? CoverKey { get; set; }

    /// <summary>Hidden provenance, opaque JSON: <c>{"kind":"upload"}</c>, <c>{"kind":"clip",…}</c>, <c>{"kind":"catalog",…}</c>.</summary>
    public string Origin { get; set; } = """{"kind":"upload"}""";

    public bool CheckpointSavingEnabled { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? RemovedAt { get; set; }

    /// <summary>The version being read; null for a book with no file yet.</summary>
    public BookFile? CurrentFile { get; set; }
}
