namespace Domain.Discussion;

/// <summary>
/// An assistant's conclusion about a book or one of its chapters, or a structured chapter review
/// (V2 table <c>book_insight</c>; ADR-016, ADR-031). One per user, book and chapter: saving again
/// replaces it. The V2 shape of <c>Domain.Entities.BookInsight</c>, which the legacy table keeps
/// until its callers move (M2.4): one <see cref="BookId"/> instead of an edition or an upload.
/// </summary>
public class BookInsight
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }

    /// <summary>The chapter this is about; null for the whole book.</summary>
    public string? ChapterSlug { get; set; }

    /// <summary>The conclusion as Markdown; for a review, the review rendered as Markdown.</summary>
    public string Text { get; set; } = "";

    /// <summary>The question this answers, when there was one.</summary>
    public string? Question { get; set; }

    public string Source { get; set; } = "mcp";

    /// <summary>The structured chapter review (opaque JSON) when this is one; null for a plain insight.</summary>
    public string? ReviewJson { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
