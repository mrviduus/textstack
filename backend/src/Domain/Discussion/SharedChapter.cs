namespace Domain.Discussion;

/// <summary>
/// A chapter the user explicitly shared with an assistant (V2 table <c>shared_chapters</c>, ADR-031):
/// an immutable snapshot of its text and of the user's notes at that moment. Sharing again makes a
/// new snapshot; nothing edits one.
/// </summary>
public class SharedChapter
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }

    /// <summary>The file version the text was taken from; null when the server holds no file.</summary>
    public Guid? FileId { get; set; }

    public string ChapterKey { get; set; } = "";
    public string? ChapterTitle { get; set; }
    public string ChapterText { get; set; } = "";

    /// <summary>Opaque JSON array: the user's notes on the chapter when it was shared.</summary>
    public string NotesSnapshot { get; set; } = "[]";

    public string? Language { get; set; }

    /// <summary>The client's id for this write: a retry with the same one returns the same snapshot.</summary>
    public Guid OperationId { get; set; }

    /// <summary>
    /// Lowercase hex SHA-256 of the write's canonical payload, computed by the caller: what tells a
    /// retry from a different write reusing the operation id (docs/01-architecture/v2-sync-protocol.md).
    /// </summary>
    public string PayloadSha256 { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }
}
