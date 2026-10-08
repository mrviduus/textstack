using System.Linq.Expressions;
using Domain.Entities;
using Domain.Enums;

namespace Application.UserBooks;

/// <summary>Selection for the <c>backfill-pdf-page-counts</c> CLI (#780).</summary>
public static class PdfPageCountBackfill
{
    /// <summary>A PDF upload with no stored page count, Ready or Failed — a failed PDF
    /// (e.g. scanned, no text layer) still opens in the Original layout.</summary>
    public static readonly Expression<Func<UserBook, bool>> NeedsPageCount = b =>
        b.PageCount == null
        && (b.Status == UserBookStatus.Ready || b.Status == UserBookStatus.Failed)
        && b.BookFiles.Any(f => f.Format == BookFormat.Pdf);

    /// <summary>Counts and writes one book at a time: a failure is logged and skipped, and every
    /// book already written stays written.</summary>
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
