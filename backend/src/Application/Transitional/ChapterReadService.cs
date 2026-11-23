using System.Text.Json;
using Application.Library;
using Application.Sync;
using Contracts.Sync;
using Domain.Library;
using static Application.Sync.SyncValidation;

namespace Application.Transitional;

/// <summary>
/// A file version's table of contents, as the reader synced it (<c>book_files.toc</c>, ADR-033). The server
/// extracts nothing and holds no chapter text: the assistant reads what the reader shares.
/// </summary>
public sealed class ChapterReadService(IBookAccess library) : IChapterLookup
{
    /// <summary>
    /// The reader's TOC, entry index as the order, with each entry's depth and fraction; empty until a reader
    /// writes it (one not in its shape, from before ADR-033 P3, reads as none).
    /// </summary>
    public async Task<SyncResult> ListAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        var file = await library.GetFileAsync(userId, bookId, fileId, ct);
        if (file is null) return await library.MissingBookOrFileAsync(userId, bookId, fileId, ct) ?? SyncResult.NotFound;
        return SyncResult.Ok(new FileChaptersDto(ReaderToc(file) ?? []));
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
            .Select((e, i) => new ChapterHeadingDto(e.GetProperty("key").GetString()!, i, e.GetProperty("title").GetString()!, null,
                e.GetProperty("depth").GetInt32(), e.GetProperty("fraction").GetDecimal()))
            .ToList();
    }
}
