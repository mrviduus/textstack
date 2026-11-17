using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Contracts.V2;

namespace TextStack.Ai.Mcp.Http;

/// <summary>
/// The my-library tools on the V2 sync API (<see cref="McpBridgeOptions.V2"/>, #1346): uploads, chapters, highlights,
/// insights and reading state under <c>/me/v2</c>, answered in the legacy shapes the tool catalog already maps (as
/// the vocabulary tools are), so the tools, their count and descriptions stay as they are. A V2 chapter's key is its
/// slug; its id is minted here from the file and the key (<see cref="ChapterId"/>), so listing and saving agree.
/// Catalog (edition) and chapter-review tools are not ported: in v2 mode their legacy routes answer 410, which the
/// tools report as an error.
/// </summary>
public sealed partial class TextStackApiClient
{
    // ponytail: the bridge reads whole feeds (500 rows a request) per call; one reader's library is small. A
    // server-side single-book or per-book read when a library outgrows a few thousand rows.

    /// <summary>Every row of a <c>/me/v2</c> change feed; the first refusal instead of a partial list.</summary>
    private async Task<ApiResult<List<T>>> PullAllAsync<T>(string feed, CancellationToken ct)
    {
        var rows = new List<T>();
        string? cursor = null;
        do
        {
            var url = $"{feed}?limit={V2FeedPage}" + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            var result = await SendAsync<object>(HttpMethod.Get, url, null, ct);
            if (result.Error is { } refused) return new(null, refused, result.Status, result.Code);
            var page = result.Value.Deserialize<ChangeFeedDto<T>>(JsonOptions)
                ?? throw new JsonException($"{feed} page was empty");
            rows.AddRange(page.Items);
            cursor = page.HasMore ? page.Cursor : null;
        } while (cursor is not null);
        return new(rows, null);
    }

    /// <summary>The caller's live books; a refusal throws the same way a legacy 5xx surfaced as a tool error.</summary>
    private async Task<List<BookDto>> V2BooksAsync(CancellationToken ct)
    {
        var books = await PullAllAsync<BookDto>("/me/v2/library/changes", ct);
        if (books.Error is { } e) throw new HttpRequestException(e, null, books.Status);
        return books.Value!.Where(b => b.RemovedAt is null).ToList();
    }

    private async Task<BookDto?> V2BookAsync(Guid bookId, CancellationToken ct) =>
        (await V2BooksAsync(ct)).FirstOrDefault(b => b.Id == bookId);

    private async Task<IReadOnlyList<ChapterHeadingDto>> V2ChaptersAsync(Guid bookId, Guid fileId, CancellationToken ct)
    {
        var listed = await SendAsync<object>(HttpMethod.Get, $"/me/v2/books/{bookId}/files/{fileId}/chapters", null, ct);
        return listed.Error is null ? listed.Value.Deserialize<FileChaptersDto>(JsonOptions)?.Items ?? [] : [];
    }

    /// <summary>A V2 chapter's id for the tools: stable per (file, key), so a listed id saves into the same chapter.</summary>
    internal static Guid ChapterId(Guid fileId, string chapterKey) =>
        new(SHA256.HashData(Encoding.UTF8.GetBytes($"{fileId:D}\n{chapterKey}")).AsSpan(0, 16));

    private async Task<UserBookDetailJson?> GetMyBookV2Async(Guid bookId, CancellationToken ct)
    {
        if (await V2BookAsync(bookId, ct) is not { } book) return null;
        var file = book.CurrentFile;
        var chapters = file is null ? [] : await V2ChaptersAsync(bookId, file.Id, ct);
        return new UserBookDetailJson(book.Id, book.Title, book.Id.ToString(), book.Language ?? "", book.Author, book.Description,
            book.Genre, book.PublishedYear, file?.WordCount,
            // Legacy's statuses: an ingestion job queued or running is Processing; none (an imported file) is Ready.
            file?.Ingestion switch { "queued" or "processing" => "Processing", "failed" => "Failed", _ => "Ready" },
            file?.Format == "pdf",
            chapters.Select(c => new UserChapterSummaryJson(ChapterId(file!.Id, c.ChapterKey), c.ChapterNumber, c.ChapterKey, c.Title, c.WordCount)).ToList());
    }

    private async Task<UserChapterJson?> GetMyChapterV2Async(Guid bookId, string chapterKey, CancellationToken ct)
    {
        if ((await V2BookAsync(bookId, ct))?.CurrentFile is not { } file) return null;
        var read = await SendAsync<object>(HttpMethod.Get,
            $"/me/v2/books/{bookId}/files/{file.Id}/chapters/{Uri.EscapeDataString(chapterKey)}", null, ct);
        if (read.Error is not null) return null;
        var c = read.Value.Deserialize<ChapterDto>(JsonOptions)!;
        static UserChapterNavJson? Nav(ChapterHeadingDto? h) => h is null ? null : new(h.ChapterNumber, h.ChapterKey, h.Title);
        return new UserChapterJson(ChapterId(file.Id, c.ChapterKey), c.ChapterNumber, c.ChapterKey, c.Title, c.Html, c.WordCount,
            Nav(c.Previous), Nav(c.Next));
    }

    /// <summary>V2 has no full-text search: the query matches the title or the author. Tags are not filtered.</summary>
    private async Task<IReadOnlyList<UserBookSearchHitJson>> SearchMyLibraryV2Async(string query, CancellationToken ct)
    {
        var q = query.Trim();
        return (await V2BooksAsync(ct))
            .Where(b => b.Title.Contains(q, StringComparison.OrdinalIgnoreCase) || b.Author?.Contains(q, StringComparison.OrdinalIgnoreCase) == true)
            .Select(b => new UserBookSearchHitJson(b.Id, b.Title, b.Author, null, b.Language ?? "", 1, null, null))
            .ToList();
    }

    private async Task<IReadOnlyList<HighlightJson>?> GetUserBookHighlightsV2Async(Guid bookId, CancellationToken ct)
    {
        if (await V2BookAsync(bookId, ct) is null) return null;
        var feed = await PullAllAsync<AnnotationDto>("/me/v2/annotations/changes", ct);
        if (feed.Error is not null) return null;
        return feed.Value!
            .Where(a => a.BookId == bookId && a.DeletedAt is null)
            .OrderBy(a => a.CreatedAt)
            .Select(a => new HighlightJson(a.Id, null, ChapterKeyOf(a.Locator) is { } key && a.FileId is { } f ? ChapterId(f, key) : null,
                a.Color, a.SelectedText, a.NoteText, a.CreatedAt))
            .ToList();
    }

    /// <summary>The chapter a <c>textstack-anchor-v1</c> locator names; null for any other scheme.</summary>
    private static string? ChapterKeyOf(string? locator)
    {
        if (locator is null) return null;
        using var json = JsonDocument.Parse(locator);
        var root = json.RootElement;
        return root.TryGetProperty("scheme", out var s) && s.GetString() == "textstack-anchor-v1"
            && root.GetProperty("value").TryGetProperty("chapterKey", out var key) ? key.GetString() : null;
    }

    private const int V2MaxSelectedText = 4000;

    /// <summary>
    /// <c>PUT /me/v2/annotations/{id}</c>: the same synthesized text quote as legacy's write (no DOM here), as a
    /// <c>textstack-anchor-v1</c> on the chapter <paramref name="chapterId"/> names in the book's current file.
    /// </summary>
    private async Task<HighlightJson?> SaveUserBookHighlightV2Async(
        Guid bookId, Guid chapterId, string color, string selectedText, string? noteText, CancellationToken ct)
    {
        // ponytail: legacy's 200-assistant-highlights-per-book ceiling is not counted on V2; add it to the
        // annotations write if an assistant ever floods a book.
        if ((await V2BookAsync(bookId, ct))?.CurrentFile is not { } file) return null;
        var chapter = (await V2ChaptersAsync(bookId, file.Id, ct)).FirstOrDefault(c => ChapterId(file.Id, c.ChapterKey) == chapterId);
        if (chapter is null) return null;

        var text = selectedText.Length > V2MaxSelectedText ? selectedText[..V2MaxSelectedText] : selectedText;
        var locator = JsonSerializer.SerializeToElement(new
        {
            version = 1,
            scheme = "textstack-anchor-v1",
            value = new { chapterKey = chapter.ChapterKey, prefix = "", exact = text, suffix = "", startOffset = 0, endOffset = text.Length, source = "mcp" },
        });
        var saved = await SendAsync(HttpMethod.Put, $"/me/v2/annotations/{Guid.NewGuid()}",
            new AnnotationRequest(null, bookId, file.Id, text, noteText, locator, color), ct);
        if (saved.Error is not null) return null;
        var a = saved.Value.Deserialize<AnnotationDto>(JsonOptions)!;
        return new HighlightJson(a.Id, null, chapterId, a.Color, a.SelectedText, a.NoteText, a.CreatedAt);
    }

    private async Task<IReadOnlyList<BookInsightJson>?> GetInsightsV2Async(Guid bookId, CancellationToken ct)
    {
        var listed = await SendAsync<object>(HttpMethod.Get, $"/me/v2/books/{bookId}/insights", null, ct);
        return listed.Error is null ? listed.Value.Deserialize<List<InsightDto>>(JsonOptions)!.Select(ToInsightJson).ToList() : null;
    }

    private async Task<BookInsightJson?> SaveInsightV2Async(Guid bookId, string? chapterSlug, string text, string? question, CancellationToken ct)
    {
        var saved = await SendAsync(HttpMethod.Post, $"/me/v2/books/{bookId}/insights", new InsightRequest(chapterSlug, text, question), ct);
        return saved.Error is null ? ToInsightJson(saved.Value.Deserialize<InsightDto>(JsonOptions)!) : null;
    }

    private static BookInsightJson ToInsightJson(InsightDto i) =>
        new(i.Id, null, i.BookId, i.ChapterKey, i.ChapterNumber, i.ChapterTitle, i.Text, i.Question, i.Source, i.CreatedAt, i.UpdatedAt);

    /// <summary>The chapter a <c>textstack-position-v1</c> reading position names; null for any other scheme.</summary>
    private static string? PositionChapterOf(string locator)
    {
        using var json = JsonDocument.Parse(locator);
        var root = json.RootElement;
        return root.TryGetProperty("scheme", out var s) && s.GetString() == "textstack-position-v1"
            && root.GetProperty("value").TryGetProperty("chapterSlug", out var key) ? key.GetString() : null;
    }

    private async Task<ReadingStateDto?> V2ReadingStateAsync(Guid bookId, CancellationToken ct)
    {
        var read = await SendAsync<object>(HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state", null, ct);
        return read.Error is null ? read.Value.Deserialize<ReadingStateDto>(JsonOptions) : null;
    }

    private async Task<UserBookProgressJson?> GetUserBookProgressV2Async(Guid bookId, CancellationToken ct) =>
        await V2ReadingStateAsync(bookId, ct) is { } s
            ? new(PositionChapterOf(s.CurrentLocator), null, (double)s.BookFraction, s.UpdatedAt)
            : null;

    /// <summary>
    /// <c>PUT /me/v2/books/{id}/reading-state</c> at the start of <paramref name="chapterSlug"/> (a <c>textstack-position-v1</c>,
    /// as the transitional reader writes), on the revision just read; a finished book is completed now.
    /// </summary>
    private async Task<bool> SetUserBookProgressV2Async(Guid bookId, string? chapterSlug, double? percent, CancellationToken ct)
    {
        if (chapterSlug is null || (await V2BookAsync(bookId, ct))?.CurrentFile is not { } file) return false;
        var current = await V2ReadingStateAsync(bookId, ct);
        var fraction = (decimal)Math.Clamp(percent ?? 0, 0, 1);
        var locator = JsonSerializer.SerializeToElement(new
        {
            version = 1,
            scheme = "textstack-position-v1",
            value = new { chapterSlug, chapterFraction = 0 },
        });
        var now = DateTimeOffset.UtcNow;
        var written = await SendAsync(HttpMethod.Put, $"/me/v2/books/{bookId}/reading-state",
            new ReadingStateRequest(current?.Revision, file.Id, locator, fraction, null, null, fraction >= 1 ? now : null, now), ct);
        return written.Error is null;
    }

    /// <summary>
    /// <c>get_my_reading</c>'s two reads on V2: the uploads with their reading states. In progress = opened and not
    /// completed, last read first; finished this month = completed since the first of this (UTC) month.
    /// </summary>
    private async Task<(ShelvesJson Shelves, IReadOnlyList<MyBookJson> All)> ReadingV2Async(CancellationToken ct)
    {
        var books = await V2BooksAsync(ct);
        var feed = await PullAllAsync<ReadingStateDto>("/me/v2/reading/changes", ct);
        if (feed.Error is { } e) throw new HttpRequestException(e, null, feed.Status);
        var states = feed.Value!.ToDictionary(s => s.BookId);

        var now = DateTimeOffset.UtcNow;
        var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
        ShelfItemJson Shelf(BookDto b, ReadingStateDto s) =>
            new(b.Id, "userbook", b.Title, b.Author, null, (double)s.BookFraction, s.UpdatedAt, PositionChapterOf(s.CurrentLocator));
        var read = books.Where(b => states.ContainsKey(b.Id)).Select(b => (Book: b, State: states[b.Id])).ToList();
        var shelves = new ShelvesJson(
            read.Where(r => r.State.CompletedAt is null).OrderByDescending(r => r.State.UpdatedAt).Select(r => Shelf(r.Book, r.State)).ToList(),
            null,
            read.Where(r => r.State.CompletedAt >= monthStart).OrderByDescending(r => r.State.CompletedAt).Select(r => Shelf(r.Book, r.State)).ToList());
        var all = books.Select(b =>
        {
            var s = states.GetValueOrDefault(b.Id);
            return new MyBookJson(b.Id, b.Title, b.Id.ToString(), b.Author, "Ready", b.CurrentFile?.ChapterCount ?? 0,
                s is null ? null : (double)s.BookFraction, s is null ? null : PositionChapterOf(s.CurrentLocator), s?.CompletedAt);
        }).ToList();
        return (shelves, all);
    }
}
