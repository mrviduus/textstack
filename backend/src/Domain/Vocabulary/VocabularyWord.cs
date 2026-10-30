namespace Domain.Vocabulary;

/// <summary>
/// One learning card per user, language and <see cref="WordKey"/> (V2 table <c>vocabulary_words</c>,
/// ADR-031), with its review schedule. Examples and reviews hang on it. Deleting only sets
/// <see cref="DeletedAt"/>, and the tombstone keeps its key, so saving the word again needs a restore.
/// </summary>
public class VocabularyWord
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Language { get; set; } = "";

    /// <summary>The spelling the card was first saved with.</summary>
    public string Word { get; set; } = "";

    /// <summary>The application's language-aware lowercasing of the word; the database does not compute it.</summary>
    public string WordKey { get; set; } = "";

    public string? Translation { get; set; }
    public string? Definition { get; set; }

    // The schedule. Set by the server from the SRS result a review carries; ignored on save.
    public int Stage { get; set; }
    public decimal IntervalDays { get; set; }
    public int ConsecutiveCorrect { get; set; }
    public DateTimeOffset NextReviewAt { get; set; }
    public DateTimeOffset? LastReviewedAt { get; set; }

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Set by the server on delete; ignored on write.</summary>
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>Set by the server: 1 on creation, +1 on each edit, delete and restore (not on reviews or examples); ignored on write.</summary>
    public long Revision { get; set; }

    /// <summary>The examples that are not deleted, oldest first; filled only where a read says it returns them.</summary>
    public List<VocabularyExample> Examples { get; set; } = [];
}
