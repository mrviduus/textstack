namespace Domain.Transitional;

/// <summary>
/// A server-extracted chapter of one file version (V2 table <c>book_chapters</c>), keyed by the file,
/// not the book, so re-extracting another version cannot mix chapters. Transitional: it feeds the
/// legacy reader, <c>get_my_chapter</c> and share snapshots until M6.4 (ADR-031).
/// </summary>
public class BookChapter : BookChapterHeading
{
    public Guid UserId { get; set; }
    public Guid BookId { get; set; }
    public Guid FileId { get; set; }
    public string Html { get; set; } = "";
    public string PlainText { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
}
