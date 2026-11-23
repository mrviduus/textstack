using Application.Sync;
using Contracts.Sync;

namespace Application.Transitional;

/// <summary>
/// Transitional's public port for the other features (ADR-034 rule 4): a file version's chapters as the reader
/// synced them (<c>book_files.toc</c>, ADR-033), and whether a chapter key is one of them. Implemented by
/// <see cref="ChapterReadService"/>.
/// </summary>
public interface IChapterLookup
{
    /// <summary>The TOC in reading order, the entry's index as its number; null when no reader has synced it yet.</summary>
    Task<IReadOnlyList<ChapterHeadingDto>?> ListTocAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>Null when the file's TOC has <paramref name="chapterKey"/>; else <c>chapter_not_found</c>, <see cref="SyncResult.TocNotSynced"/> when there is no TOC.</summary>
    Task<SyncResult?> CheckKeyAsync(Guid userId, Guid bookId, Guid fileId, string chapterKey, CancellationToken ct);
}
