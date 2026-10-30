namespace Domain.Vocabulary;

/// <summary>
/// A source sentence for a <see cref="VocabularyWord"/> (V2 table <c>vocabulary_examples</c>), with
/// where it came from when known. <see cref="OperationId"/> identifies a retry, not duplicate content:
/// the same sentence under a new operation is a second example.
/// </summary>
public class VocabularyExample
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid WordId { get; set; }
    public Guid? BookId { get; set; }

    /// <summary>A file version of <see cref="BookId"/>.</summary>
    public Guid? FileId { get; set; }

    /// <summary>A resource key within the file, not a database chapter id; needs <see cref="BookId"/>.</summary>
    public string? ChapterKey { get; set; }

    /// <summary>Snapshot, so the example keeps its source even when it never was a library book.</summary>
    public string? BookTitle { get; set; }

    public string Sentence { get; set; } = "";
    public string? ContextualTranslation { get; set; }
    public Guid OperationId { get; set; }

    /// <summary>Lowercase hex SHA-256 of the payload's canonical JSON, computed by the server before the write (v2-sync-protocol.md).</summary>
    public string PayloadSha256 { get; set; } = "";

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Ignored on write.</summary>
    public DateTimeOffset? DeletedAt { get; set; }
}
