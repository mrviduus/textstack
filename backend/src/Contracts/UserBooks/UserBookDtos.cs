namespace Contracts.UserBooks;

// HasOriginalPdf lets the upload redirect open a PDF into "Original layout"
// immediately — the file is stored at upload, so it is true the instant a PDF lands.
public record UploadUserBookResponse(Guid UserBookId, Guid JobId, string Status, bool HasOriginalPdf);

/// <summary>
/// "Send to TextStack" web clip — the extension sends already-clean (Readability) article HTML.
/// The server never fetches a URL. Lands on the private Read later shelf.
/// </summary>
public record ClipRequest(string Title, string? Author, string? SourceUrl, string Html, string? Language);

/// <param name="Tier">Entitlement tier name (Guest|Free|Supporter|Staff).</param>
/// <param name="MaxBooks">Book-count cap, or null for unlimited.</param>
/// <param name="MaxSingleUploadBytes">
/// Largest body a single request may carry — a PLATFORM limit (Cloudflare), not a tier perk.
/// Clients use it to decide when to switch to the chunked upload path, and to explain the refusal
/// honestly instead of surfacing a raw 413.
/// </param>
public record StorageQuotaDto(
    long UsedBytes,
    long LimitBytes,
    double UsedPercent,
    string Tier,
    int? MaxBooks,
    int BooksUsed,
    long MaxSingleUploadBytes);
