namespace Domain.Vocabulary;

/// <summary>
/// One answer to a <see cref="VocabularyWord"/> (V2 table <c>vocabulary_reviews</c>), append-only.
/// The stages are the SRS result the caller computed; the card's schedule moves with it.
/// </summary>
public class VocabularyReview
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid WordId { get; set; }
    public Guid OperationId { get; set; }

    /// <summary>Lowercase hex SHA-256 of the payload's canonical JSON, computed by the server before the write (v2-sync-protocol.md).</summary>
    public string PayloadSha256 { get; set; } = "";

    /// <summary>The review style; the clients own the values.</summary>
    public string ReviewMode { get; set; } = "";

    public bool IsCorrect { get; set; }
    public int? ResponseTimeMs { get; set; }
    public int StageBefore { get; set; }
    public int StageAfter { get; set; }

    /// <summary>When the client recorded the answer, by its clock.</summary>
    public DateTimeOffset ClientRecordedAt { get; set; }

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}
