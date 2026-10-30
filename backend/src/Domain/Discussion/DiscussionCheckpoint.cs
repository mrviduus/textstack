namespace Domain.Discussion;

/// <summary>
/// One saved stage of a discussion about a book (V2 table <c>discussion_checkpoints</c>, ADR-031):
/// what was discussed, what the reader thought, what the assistant suggested, what was concluded and
/// what is still open. Append-only: a new stage is a new row, older thoughts are never rewritten
/// (docs/01-architecture/mcp-discussion-checkpoints.md).
/// </summary>
public class DiscussionCheckpoint
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }

    /// <summary>The file version discussed, when known.</summary>
    public Guid? FileId { get; set; }

    /// <summary>The chapter discussed; null for the whole book.</summary>
    public string? ChapterKey { get; set; }

    /// <summary>The snapshot the discussion was based on; cleared when the user deletes that share.</summary>
    public Guid? SharedChapterId { get; set; }

    public string Topic { get; set; } = "";

    // The four sections are opaque JSON arrays; at least one of them is not empty.
    public string ReaderThoughts { get; set; } = "[]";
    public string AssistantSuggestions { get; set; } = "[]";
    public string Conclusions { get; set; } = "[]";
    public string OpenQuestions { get; set; } = "[]";

    /// <summary>The language the discussion was held in; the record stays in it.</summary>
    public string Language { get; set; } = "";

    /// <summary>The client's id for this write: a retry with the same one returns the same row.</summary>
    public Guid OperationId { get; set; }

    /// <summary>
    /// Lowercase hex SHA-256 of the write's canonical payload, computed by the caller: what tells a
    /// retry from a different write reusing the operation id (docs/01-architecture/v2-sync-protocol.md).
    /// </summary>
    public string PayloadSha256 { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }
}
