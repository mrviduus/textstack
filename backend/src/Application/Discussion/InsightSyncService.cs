using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
using Domain.Discussion;
using static Application.Sync.SyncValidation;

namespace Application.Discussion;

/// <summary>
/// The /me/v2 insights (#1346): an assistant's conclusions on a book, one per (book, chapter), the whole book
/// under no chapter; saving over one replaces it. The rules of legacy's <c>/me/insights</c> on V2's
/// <c>book_insight</c>: a chapter must be in the TOC the reader synced for the book's current file (ADR-033), and a structured chapter review in the
/// slot is never overwritten (409 <c>review_exists</c>).
/// </summary>
public sealed class InsightSyncService(IBookAccess library, IBookInsightRepository insights, IChapterLookup chapters)
{
    public const int MaxText = 20_000;
    public const int MaxQuestion = 1000;

    /// <summary>
    /// The book's insights in reading order: the whole book first, then by TOC order, an unplaced one last (a key the TOC
    /// lacks, such as the server's old slug or <c>ch-N</c>: listed without its chapter's title).
    /// </summary>
    public async Task<SyncResult> ListAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;

        var rows = await insights.ListForBookAsync(userId, bookId, ct);
        var toc = rows.Any(r => r.ChapterSlug is not null) && book.CurrentFile is { } file
            ? (await chapters.ListTocAsync(userId, bookId, file.Id, ct) ?? []).ToDictionary(c => c.ChapterKey, StringComparer.Ordinal)
            : [];
        return SyncResult.Ok(rows
            .Select(r => ToDto(r, r.ChapterSlug is { } key && toc.TryGetValue(key, out var c) ? c : null))
            .OrderBy(d => d.ChapterKey is null ? 0 : 1)
            .ThenBy(d => d.ChapterNumber ?? int.MaxValue)
            .ThenBy(d => d.CreatedAt)
            .ToList());
    }

    public async Task<SyncResult> SaveAsync(Guid userId, Guid bookId, InsightRequest r, CancellationToken ct)
    {
        // "" means the whole book, as null: never two book-level rows.
        var chapterKey = string.IsNullOrWhiteSpace(r.ChapterKey) ? null : r.ChapterKey.Trim();
        if ((RequiredText(r.Text, "text", MaxText) ?? Text(chapterKey, "chapterKey", SyncLimits.MaxChapterKey) ?? Text(r.Question, "question", MaxQuestion))
            is { } invalid) return invalid;

        var book = await library.GetAsync(userId, bookId, ct);
        if (book is null) return SyncResult.BookNotFound;
        // A key the file does not have is usually a guessed one: say so while the caller can fix it.
        ChapterHeadingDto? heading = null;
        if (chapterKey is not null)
        {
            if (book.CurrentFile is not { } file) return SyncResult.ChapterNotFound;
            if (await chapters.ListTocAsync(userId, bookId, file.Id, ct) is not { } toc) return SyncResult.TocNotSynced;
            heading = toc.FirstOrDefault(c => c.ChapterKey == chapterKey);
            if (heading is null) return SyncResult.ChapterNotFound;
        }

        var id = Guid.CreateVersion7();
        var saved = await insights.SaveAsync(new BookInsight
        {
            Id = id,
            UserId = userId,
            BookId = bookId,
            ChapterSlug = chapterKey,
            Text = r.Text!,
            Question = r.Question,
            Source = "mcp",
        }, ct);
        if (saved is null) return SyncResult.Fail(SyncCodes.ReviewExists);
        return SyncResult.Written(saved.Id == id, ToDto(saved, heading));
    }

    private static InsightDto ToDto(BookInsight r, ChapterHeadingDto? chapter) =>
        new(r.Id, r.BookId, r.ChapterSlug, chapter?.ChapterNumber, chapter?.Title, r.Text, r.Question, r.Source, r.CreatedAt, r.UpdatedAt);
}
