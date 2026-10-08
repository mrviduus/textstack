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
}
