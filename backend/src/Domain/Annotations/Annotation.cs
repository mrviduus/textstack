namespace Domain.Annotations;

/// <summary>
/// A highlight with an optional note in one user's book (V2 table <c>annotations</c>, ADR-031), or an
/// unanchored quotation: a migrated catalog highlight keeps its text with no <see cref="FileId"/> and
/// no <see cref="Locator"/>. Deleting only sets <see cref="DeletedAt"/>, a tombstone other devices sync.
/// </summary>
public class Annotation
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    /// <summary>The book the annotation belongs to; fixed at its first write.</summary>
    public Guid BookId { get; set; }

    /// <summary>The file version the locator points into; required when there is a locator.</summary>
    public Guid? FileId { get; set; }

    public string SelectedText { get; set; } = "";
    public string? NoteText { get; set; }

    /// <summary>Opaque envelope JSON (ADR-031 "Locator schemes"); null for an unanchored quotation.</summary>
    public string? Locator { get; set; }

    public string Color { get; set; } = "yellow";

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Set by the server on delete; ignored on write.</summary>
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>Set by the server: 1 on the first write, +1 on each accepted one; ignored on write.</summary>
    public long Revision { get; set; }
}
