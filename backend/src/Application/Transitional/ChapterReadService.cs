using System.Text.Json;
using Application.Library;
using Application.Sync;
using Contracts.Sync;
using Domain.Library;
using Domain.Transitional;
using static Application.Sync.SyncValidation;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>The server-extracted chapters of an uploaded file version, read-only (#1091: no editing on
/// V2), for the readers that still open a book chapter by chapter (M2.7).</para>
/// </summary>
public sealed class ChapterReadService(IBookAccess library, IBookChapterRepository chapters, IIngestionJobRepository jobs) : IChapterLookup
{
    /// <summary>
    /// The table of contents: the reader's (<c>book_files.toc</c>, ADR-033 P3) once written in its shape, entry index as the
    /// order and <c>succeeded</c> as the status so older clients keep it; else the extracted chapters, empty
    /// while the extraction runs, and that extraction's status.
    /// </summary>
    public async Task<SyncResult> ListAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        var file = await library.GetFileAsync(userId, bookId, fileId, ct);
        if (file is null) return await library.MissingBookOrFileAsync(userId, bookId, fileId, ct) ?? SyncResult.NotFound;
        if (ReaderToc(file) is { } written) return SyncResult.Ok(new FileChaptersDto(written, FileIngestionJob.Succeeded));
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

    public async Task<IReadOnlyList<ChapterHeadingDto>?> ListTocAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct) =>
        await library.GetFileAsync(userId, bookId, fileId, ct) is { } file ? ReaderToc(file) : null;

    public async Task<SyncResult?> CheckKeyAsync(Guid userId, Guid bookId, Guid fileId, string chapterKey, CancellationToken ct) =>
        await ListTocAsync(userId, bookId, fileId, ct) switch
        {
            null => SyncResult.TocNotSynced,
            var toc when toc.Any(c => c.ChapterKey == chapterKey) => null,
            _ => SyncResult.ChapterNotFound,
        };

    /// <summary>The reader's TOC, entry index as the order; null when none is written, or one not in its shape (a free-form row from before P3).</summary>
    private static List<ChapterHeadingDto>? ReaderToc(BookFile file)
    {
        if (file.Toc is null || Toc(file.Toc, "toc") is not null) return null;
        using var written = JsonDocument.Parse(file.Toc);
        return written.RootElement.EnumerateArray()
            .Select((e, i) => new ChapterHeadingDto(e.GetProperty("key").GetString()!, i, e.GetProperty("title").GetString()!, null))
            .ToList();
    }

    private static ChapterHeadingDto ToDto(BookChapterHeading h) => new(h.ChapterKey, h.ChapterNumber, h.Title, h.WordCount);
}
