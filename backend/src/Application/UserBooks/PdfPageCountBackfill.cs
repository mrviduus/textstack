using System.Linq.Expressions;
using Domain.Entities;
using Domain.Enums;

namespace Application.UserBooks;

/// <summary>PDF-2: the <c>backfill-pdf-page-counts</c> CLI — PDF uploads ingested before
/// <see cref="UserBook.PageCount"/> existed.</summary>
public static class PdfPageCountBackfill
{
    /// <summary>A PDF upload with no stored page count, in any status.</summary>
    public static readonly Expression<Func<UserBook, bool>> NeedsPageCount = b =>
        b.PageCount == null && b.BookFiles.Any(f => f.Format == BookFormat.Pdf);

    /// <summary>One book at a time: a failure is logged and skipped; every book already
    /// written stays written.</summary>
    public static async Task<(int Updated, int Failed)> RunAsync(
        IEnumerable<(Guid Id, string Path)> books,
        Func<string, int?> countPages,
        Func<Guid, int, Task> write,
        Action<string> log)
    {
        int updated = 0, failed = 0;
        foreach (var (id, path) in books)
        {
            try
            {
                if (countPages(path) is not { } pages)
                {
                    failed++;
                    log($"[FAIL] {id} {path} unreadable");
                    continue;
                }
                await write(id, pages);
                updated++;
                log($"[OK]   {id} {pages} pages");
            }
            catch (Exception ex)
            {
                failed++;
                log($"[FAIL] {id} {path} {ex.Message}");
            }
        }
        return (updated, failed);
    }
}
