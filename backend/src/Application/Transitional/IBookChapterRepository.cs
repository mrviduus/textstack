using Domain.Transitional;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>The server-extracted chapters of one file version (table <c>book_chapters</c>), keyed by
/// <c>(userId, fileId)</c>: another user's ids read as "not found" (docs/01-architecture/data-access.md
/// rule 7). Chapters come in <c>chapter_number</c> order, which only orders: show the title.</para>
/// </summary>
public interface IBookChapterRepository
{
    /// <summary>The file's table of contents, in order, without the chapters' text; empty when none.</summary>
    Task<IReadOnlyList<BookChapterHeading>> ListTocAsync(Guid userId, Guid fileId, CancellationToken ct);

    /// <summary>The whole chapter, text included; null when the file has no chapter under that key.</summary>
    Task<BookChapter?> GetAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>
    /// The chapters before and after the one under <paramref name="chapterKey"/> in reading order
    /// (gaps in the numbering are skipped); each null at an end of the book, both when there is no such chapter.
    /// </summary>
    Task<(BookChapterHeading? Previous, BookChapterHeading? Next)> GetNeighboursAsync(
        Guid userId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>The chapter's plain text, for the assistant and the review; null when no such chapter.</summary>
    Task<string?> GetPlainTextAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>
    /// Stores the chapters extracted from one file version of the user's book, all or none. The file
    /// must be the book's and the user's (the FK refuses it otherwise, as a broken invariant).
    /// </summary>
    Task InsertForFileAsync(Guid userId, Guid bookId, Guid fileId, IReadOnlyList<BookChapter> chapters, CancellationToken ct);
}
