using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Transitional;
using static Application.Sync.SyncValidation;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>The server-extracted chapters of an uploaded file version, read-only (#1091: no editing on
/// V2), for the readers that still open a book chapter by chapter (M2.7).</para>
/// </summary>
public sealed class ChapterReadService(ILibraryRepository library, IBookChapterRepository chapters, IIngestionJobRepository jobs)
{
    /// <summary>The table of contents, empty while the extraction runs, and that extraction's status.</summary>
    public async Task<SyncResult> ListAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        if (await library.MissingBookOrFileAsync(userId, bookId, fileId, ct) is { } missing) return missing;
        var toc = await chapters.ListTocAsync(userId, bookId, fileId, ct);
        var job = await jobs.GetLatestForFileAsync(userId, bookId, fileId, ct);
        return SyncResult.Ok(new FileChaptersDto(toc.Select(ToDto).ToList(), job?.Status));
    }

    /// <summary>One chapter with its neighbours in reading order; the book and file are checked only when it is not found, to pick the code.</summary>
    public async Task<SyncResult> GetAsync(Guid userId, Guid bookId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        if (RequiredText(chapterKey, "chapterKey", SyncLimits.MaxChapterKey) is { } invalid) return invalid;
        var (chapter, previous, next) = await chapters.GetWithNeighboursAsync(userId, bookId, fileId, chapterKey, ct);
        if (chapter is null) return await library.MissingBookOrFileAsync(userId, bookId, fileId, ct) ?? SyncResult.NotFound;
        return SyncResult.Ok(new ChapterDto(
            chapter.ChapterKey, chapter.ChapterNumber, chapter.Title, chapter.Html, chapter.WordCount,
            previous is null ? null : ToDto(previous), next is null ? null : ToDto(next)));
    }

    private static ChapterHeadingDto ToDto(BookChapterHeading h) => new(h.ChapterKey, h.ChapterNumber, h.Title, h.WordCount);
}
