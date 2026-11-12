using Domain.Transitional;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>The server-extracted chapters of one file version (table <c>book_chapters</c>): a file is
/// named by its <c>(userId, bookId, fileId)</c>, a chapter by <c>(userId, fileId, chapterKey)</c>;
/// another user's ids read as "not found" (docs/architecture/data-access.md rule 7). Chapters come
/// in <c>chapter_number</c> order, which only orders: show the title.</para>
/// </summary>
public interface IBookChapterRepository
{
    /// <summary>The file's table of contents, in order, without the chapters' text; empty when none.</summary>
    Task<IReadOnlyList<BookChapterHeading>> ListTocAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>
    /// The whole chapter under <paramref name="chapterKey"/> in that file version of the book, text included,
    /// and the chapters before and after it in reading order (gaps in the numbering are skipped; each null at
    /// an end of the book). All null when the file has no chapter under that key.
    /// </summary>
    Task<(BookChapter? Chapter, BookChapterHeading? Previous, BookChapterHeading? Next)> GetWithNeighboursAsync(
        Guid userId, Guid bookId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>Whether that file version has a chapter under <paramref name="chapterKey"/>: the pre-check of a <c>textstack-*</c> locator.</summary>
    Task<bool> ExistsAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>The chapter's plain text, for the assistant and the review; null when no such chapter.</summary>
    Task<string?> GetPlainTextAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct);

    /// <summary>
    /// Replaces the chapters of one file version of the user's book with <paramref name="chapters"/>, all
    /// or none (#1091: replace-all, not reconcile). On V2 a chapter belongs to a file version, and
    /// annotations anchor by locator, not by chapter id, so a re-extraction has nothing to keep. The
    /// file must be the book's and the user's (the FK refuses it otherwise, as a broken invariant).
    /// </summary>
    Task ReplaceForFileAsync(Guid userId, Guid bookId, Guid fileId, IReadOnlyList<BookChapter> chapters, CancellationToken ct);
}
