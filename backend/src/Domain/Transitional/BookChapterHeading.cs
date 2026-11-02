namespace Domain.Transitional;

/// <summary>
/// A table-of-contents entry of a server-extracted chapter (V2 table <c>book_chapters</c>) — what a
/// list of chapters needs, without their text. <see cref="ChapterNumber"/> orders, it is never shown:
/// show <see cref="Title"/>. Transitional: dropped at M6.4 (ADR-031).
/// </summary>
public class BookChapterHeading
{
    public Guid Id { get; set; }

    /// <summary>The chapter's slug, or <c>ch-</c> + its number when it had none; unique per file version.</summary>
    public string ChapterKey { get; set; } = "";

    public int ChapterNumber { get; set; }
    public string Title { get; set; } = "";
    public int? WordCount { get; set; }

    /// <summary>The 1-based PDF page range the chapter spans; null for other formats.</summary>
    public int? SourceStartPage { get; set; }

    public int? SourceEndPage { get; set; }
}
