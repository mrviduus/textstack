using Api.Extensions;
using Application.Auth;
using Application.Common.Interfaces;
using Application.UserBooks;
using Contracts.UserBooks;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;

namespace Api.Endpoints;

public static class UserBooksEndpoints
{
    public static void MapUserBooksEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/books").WithTags("User Books");

        group.MapPost("/upload", UploadBook)
            .WithName("UploadUserBook")
            .RequireRateLimiting("user-upload")
            .DisableAntiforgery();

        group.MapPost("/clip", ClipArticle)
            .WithName("ClipArticle")
            .RequireRateLimiting("clip");

        group.MapGet("", GetBooks).WithName("GetUserBooks");
        group.MapPut("/{id:guid}/read", MarkRead).WithName("MarkUserBookRead");
        group.MapGet("/quota", GetStorageQuota).WithName("GetStorageQuota");
        group.MapGet("/{id:guid}", GetBook).WithName("GetUserBook");
        group.MapGet("/{id:guid}/chapters/{slug}", GetChapterBySlug).WithName("GetUserBookChapter");
        group.MapGet("/{id:guid}/progress", GetProgress).WithName("GetUserBookProgress");
        group.MapPut("/{id:guid}/progress", UpsertProgress).WithName("UpsertUserBookProgress");
        group.MapGet("/{id:guid}/bookmarks", GetBookmarks).WithName("GetUserBookBookmarks");
        group.MapPost("/{id:guid}/bookmarks", CreateBookmark).WithName("CreateUserBookBookmark");
        group.MapDelete("/{id:guid}/bookmarks/{bookmarkId:guid}", DeleteBookmark).WithName("DeleteUserBookBookmark");
        group.MapGet("/{id:guid}/assets/{assetId:guid}", GetAsset).WithName("GetUserBookAsset");
        group.MapGet("/{id:guid}/file", GetOriginalFile).WithName("GetUserBookOriginalFile");
        group.MapPost("/{id:guid}/complete", MarkComplete).WithName("MarkUserBookComplete");
        group.MapDelete("/{id:guid}/complete", UnmarkComplete).WithName("UnmarkUserBookComplete");
        group.MapPost("/{id:guid}/retry", RetryBook).WithName("RetryUserBook");
        group.MapPost("/{id:guid}/enrich", EnrichBook).WithName("EnrichUserBook")
            .RequireRateLimiting("enrich");
        group.MapPost("/{id:guid}/cancel", CancelBook).WithName("CancelUserBook");
        group.MapDelete("/{id:guid}", DeleteBook).WithName("DeleteUserBook");
        group.MapPut("/{id:guid}/metadata", UpdateMetadata).WithName("UpdateUserBookMetadata");
        group.MapPut("/{id:guid}/tags", SetTags).WithName("SetUserBookTags");
        group.MapPost("/{id:guid}/suggested-tags/accept", AcceptSuggestedTags).WithName("AcceptSuggestedTags");
        group.MapPost("/{id:guid}/suggested-tags/dismiss", DismissSuggestedTags).WithName("DismissSuggestedTags");

        group.MapGet("/{id:guid}/stats", GetBookStats).WithName("GetUserBookStats");

        group.MapPost("/bulk/finish", BulkFinish).WithName("BulkFinishUserBooks");
        group.MapPost("/bulk/delete", BulkDelete).WithName("BulkDeleteUserBooks");
        group.MapPost("/bulk/tags", BulkTags).WithName("BulkTagsUserBooks");
        group.MapPost("/bulk/collection/{collectionId:guid}/add", BulkAddToCollection).WithName("BulkAddCollection");
        group.MapPost("/bulk/collection/{collectionId:guid}/remove", BulkRemoveFromCollection).WithName("BulkRemoveCollection");

        var libraryGroup = app.MapGroup("/me/library").WithTags("User Library");
        libraryGroup.MapGet("/tags", GetUserTags).WithName("GetUserLibraryTags");
        libraryGroup.MapGet("/search", SearchLibrary).WithName("SearchUserLibrary");
    }

    private static async Task<IResult> SearchLibrary(
        HttpContext httpContext, AuthService authService, UserBookSearchService svc,
        [FromQuery] string? q, [FromQuery] string? tags, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<UserBookSearchHitDto>());

        var tagList = string.IsNullOrWhiteSpace(tags)
            ? Array.Empty<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var hits = await svc.SearchAsync(userId.Value, q, tagList, ct);
        return Results.Ok(hits.Select(h => new UserBookSearchHitDto(
            h.Id, h.Title, h.Author, h.CoverPath, h.Language, h.Rank, h.Excerpt, h.ChapterSlug)));
    }

    private static async Task<IResult> GetBookStats(
        Guid id, HttpContext httpContext, AuthService authService, BookStatsService svc, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var stats = await svc.GetStatsAsync(userId.Value, id, ct);
        if (stats is null) return Results.NotFound();
        return Results.Ok(new BookStatsDto(
            stats.BookId, stats.SessionsCount, stats.TotalReadMinutes, stats.WordsRead,
            stats.VocabSavedCount, stats.HighlightsCount, stats.AverageWordsPerMinute, stats.EstimatedMinutesRemaining));
    }

    private static async Task<IResult> BulkFinish(
        HttpContext httpContext, AuthService authService, BulkActionService svc,
        [FromBody] BulkFinishRequest req, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var r = await svc.SetFinishedAsync(userId.Value, req.Ids ?? [], req.IsFinished, ct);
        return Results.Ok(new BulkResultDto(r.Succeeded, r.Failed.Select(f => new BulkFailureDto(f.Id, f.Reason)).ToArray()));
    }

    private static async Task<IResult> BulkDelete(
        HttpContext httpContext, AuthService authService, BulkActionService svc,
        [FromBody] BulkIdsRequest req, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var r = await svc.DeleteAsync(userId.Value, req.Ids ?? [], ct);
        return Results.Ok(new BulkResultDto(r.Succeeded, r.Failed.Select(f => new BulkFailureDto(f.Id, f.Reason)).ToArray()));
    }

    private static async Task<IResult> BulkTags(
        HttpContext httpContext, AuthService authService, BulkActionService svc,
        [FromBody] BulkTagsRequest req, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var r = await svc.AddTagsAsync(userId.Value, req.Ids ?? [], req.AddTags ?? [], req.RemoveTags ?? [], ct);
        return Results.Ok(new BulkResultDto(r.Succeeded, r.Failed.Select(f => new BulkFailureDto(f.Id, f.Reason)).ToArray()));
    }

    private static async Task<IResult> BulkAddToCollection(
        Guid collectionId, HttpContext httpContext, AuthService authService, BulkActionService svc,
        [FromBody] BulkCollectionRequest req, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var r = await svc.AddToCollectionAsync(userId.Value, collectionId, req.Ids ?? [], req.BookType, ct);
        return Results.Ok(new BulkResultDto(r.Succeeded, r.Failed.Select(f => new BulkFailureDto(f.Id, f.Reason)).ToArray()));
    }

    private static async Task<IResult> BulkRemoveFromCollection(
        Guid collectionId, HttpContext httpContext, AuthService authService, BulkActionService svc,
        [FromBody] BulkCollectionRequest req, CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var r = await svc.RemoveFromCollectionAsync(userId.Value, collectionId, req.Ids ?? [], req.BookType, ct);
        return Results.Ok(new BulkResultDto(r.Succeeded, r.Failed.Select(f => new BulkFailureDto(f.Id, f.Reason)).ToArray()));
    }

    private static async Task<IResult> SetTags(
        HttpContext httpContext,
        AuthService authService,
        TagService tagService,
        Guid id,
        [FromBody] SetTagsRequest request,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (tags, error) = await tagService.SetTagsAsync(userId.Value, id, request.Tags ?? [], ct);
        if (error is not null) return Results.NotFound();
        return Results.Ok(tags);
    }

    private static async Task<IResult> AcceptSuggestedTags(
        HttpContext httpContext,
        AuthService authService,
        TagService tagService,
        Guid id,
        [FromBody] AcceptSuggestedTagsRequest request,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (tags, error) = await tagService.AcceptSuggestedTagsAsync(userId.Value, id, request.Accepted ?? [], ct);
        if (error is not null) return Results.NotFound();
        return Results.Ok(tags);
    }

    private static async Task<IResult> DismissSuggestedTags(
        HttpContext httpContext,
        AuthService authService,
        TagService tagService,
        Guid id,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var ok = await tagService.DismissSuggestedTagsAsync(userId.Value, id, ct);
        return ok ? Results.NoContent() : Results.NotFound();
    }

    private static async Task<IResult> GetUserTags(
        HttpContext httpContext,
        AuthService authService,
        TagService tagService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var tags = await tagService.GetUserTagsAsync(userId.Value, ct);
        return Results.Ok(tags.Select(t => new TagCountDto(t.Tag, t.Count)));
    }

    private static async Task<IResult> UpdateMetadata(
        HttpContext httpContext,
        AuthService authService,
        MetadataService metadataService,
        Guid id,
        [FromBody] UpdateUserBookMetadataRequest request,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (updated, error) = await metadataService.UpdateAsync(userId.Value, id, request, ct);
        if (error is not null)
            return error == "Book not found" ? Results.NotFound() : Results.BadRequest(new { error });

        return Results.Ok(updated);
    }

    private static async Task<IResult> UploadBook(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        [FromForm] IFormFile file,
        [FromForm] string? title,
        [FromForm] string? language,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        if (file == null || file.Length == 0)
            return Results.BadRequest("No file provided");

        await using var stream = file.OpenReadStream();
        var (response, error) = await userBookService.UploadAsync(
            userId.Value, stream, file.FileName, title, language, ct);

        if (error is not null)
            return Results.BadRequest(new { error });

        return Results.Ok(response);
    }

    private const int MaxClipHtmlBytes = 2 * 1024 * 1024; // ~2 MB

    private static async Task<IResult> ClipArticle(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        [FromBody] ClipRequest request,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        if (request is null || string.IsNullOrWhiteSpace(request.Title))
            return Results.BadRequest(new { error = "Title is required" });

        if (string.IsNullOrWhiteSpace(request.Html))
            return Results.BadRequest(new { error = "Html is required" });

        if (System.Text.Encoding.UTF8.GetByteCount(request.Html) > MaxClipHtmlBytes)
            return Results.BadRequest(new { error = "Article is too large (max 2 MB)" });

        if (!string.IsNullOrWhiteSpace(request.SourceUrl) &&
            !(Uri.TryCreate(request.SourceUrl, UriKind.Absolute, out var uri) &&
              (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)))
            return Results.BadRequest(new { error = "SourceUrl must be an http(s) URL" });

        var (response, error) = await userBookService.ClipAsync(userId.Value, request, ct);
        if (error is not null)
            return Results.BadRequest(new { error });

        return Results.Ok(response);
    }

    private static async Task<IResult> GetBooks(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        [FromQuery] string? shelf,
        [FromQuery] string? status,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var books = await userBookService.GetBooksAsync(userId.Value, ct, shelf, status);
        return Results.Ok(books);
    }

    private static async Task<IResult> MarkRead(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.SetReadAsync(userId.Value, id, true, ct);
        if (!success)
            return Results.NotFound(new { error });

        return Results.NoContent();
    }

    private static async Task<IResult> GetStorageQuota(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var quota = await userBookService.GetStorageQuotaAsync(userId.Value, ct);
        return Results.Ok(quota);
    }

    private static async Task<IResult> GetBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var book = await userBookService.GetBookAsync(userId.Value, id, ct);
        if (book is null) return Results.NotFound();

        return Results.Ok(book);
    }

    private static async Task<IResult> GetChapterBySlug(
        Guid id,
        string slug,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var chapter = await userBookService.GetChapterBySlugAsync(userId.Value, id, slug, ct);
        if (chapter is null) return Results.NotFound();

        return Results.Ok(chapter);
    }

    private static async Task<IResult> GetProgress(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var progress = await userBookService.GetProgressAsync(userId.Value, id, ct);
        if (progress is null) return Results.NotFound();

        return Results.Ok(progress);
    }

    private static async Task<IResult> UpsertProgress(
        Guid id,
        UpsertUserBookProgressRequest request,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.UpsertProgressAsync(userId.Value, id, request, ct);
        if (!success)
            return Results.BadRequest(new { error });

        return Results.Ok();
    }

    private static async Task<IResult> GetBookmarks(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var bookmarks = await userBookService.GetBookmarksAsync(userId.Value, id, ct);
        return Results.Ok(bookmarks);
    }

    private static async Task<IResult> CreateBookmark(
        Guid id,
        CreateUserBookBookmarkRequest request,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (bookmark, error) = await userBookService.CreateBookmarkAsync(userId.Value, id, request, ct);
        if (error is not null)
            return Results.BadRequest(new { error });

        return Results.Ok(bookmark);
    }

    private static async Task<IResult> DeleteBookmark(
        Guid id,
        Guid bookmarkId,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.DeleteBookmarkAsync(userId.Value, id, bookmarkId, ct);
        if (!success)
            return Results.NotFound(new { error });

        return Results.NoContent();
    }

    private static async Task<IResult> GetAsset(
        Guid id,
        Guid assetId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        // Build expected path pattern
        var userIdStr = userId.Value.ToString();
        var pathPattern = $"users/{userIdStr[..2]}/{userIdStr}/books/{id}/assets/{assetId}";

        // Find file with any extension
        var basePath = storage.GetFullPath($"users/{userIdStr[..2]}/{userIdStr}/books/{id}/assets");
        if (!Directory.Exists(basePath))
            return Results.NotFound();

        var files = Directory.GetFiles(basePath, $"{assetId}.*");
        if (files.Length == 0)
            return Results.NotFound();

        var filePath = files[0];
        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        var contentType = ext switch
        {
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            _ => "image/jpeg"
        };

        var stream = await storage.GetFileAsync(
            filePath.Replace(storage.GetFullPath(""), "").TrimStart(Path.DirectorySeparatorChar), ct);

        if (stream is null)
            return Results.NotFound();

        return Results.File(stream, contentType);
    }

    /// <summary>
    /// Streams the stored original of an upload — <em>any</em> format — with HTTP
    /// Range support. Two callers: the web reader's "Original layout" view renders
    /// a PDF with PDF.js (which issues ranged requests), and the mobile reader
    /// copies the whole file to the device so the book opens offline in the layout
    /// it has online instead of being substituted with its extracted text. That
    /// second caller is why the format filter is gone: which formats a client can
    /// render is the client's business, not this endpoint's.
    /// <para>Owner-scoped; 404 for non-owner, taken-down or missing-on-disk. The
    /// physical-path
    /// <see cref="Results.File(string, string?, string?, DateTimeOffset?, EntityTagHeaderValue?, bool)"/>
    /// overload emits Accept-Ranges/ETag and serves 206 Partial Content for ranges.</para>
    /// </summary>
    private static async Task<IResult> GetOriginalFile(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var file = await db.UserBookFiles
            .Where(f => f.UserBookId == id
                        && f.UserBook.UserId == userId.Value
                        && f.UserBook.TakedownAt == null)
            .OrderByDescending(f => f.UploadedAt)
            .Select(f => new { f.StoragePath, f.UploadedAt, f.Sha256, f.Format })
            .FirstOrDefaultAsync(ct);

        if (file is null) return Results.NotFound();

        var fullPath = storage.GetFullPath(file.StoragePath);
        if (!File.Exists(fullPath)) return Results.NotFound();

        // ETag from the content hash when available → clients can revalidate cheaply.
        var etag = string.IsNullOrEmpty(file.Sha256)
            ? null
            : new EntityTagHeaderValue($"\"{file.Sha256}\"");

        // Fb2/Html/Other fall through to octet-stream on purpose: a clip's stored
        // HTML served as text/html from the API origin would be XSS on our own host.
        var contentType = file.Format switch
        {
            BookFormat.Pdf => "application/pdf",
            BookFormat.Epub => "application/epub+zip",
            _ => "application/octet-stream"
        };

        return Results.File(
            fullPath,
            contentType: contentType,
            lastModified: file.UploadedAt,
            entityTag: etag,
            enableRangeProcessing: true);
    }

    private static async Task<IResult> MarkComplete(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId.Value && b.Id == id, ct);
        if (book is null) return Results.NotFound();

        book.CompletedAt ??= DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> UnmarkComplete(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId.Value && b.Id == id, ct);
        if (book is null) return Results.NotFound();

        book.CompletedAt = null;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RetryBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.RetryAsync(userId.Value, id, ct);
        if (!success)
            return Results.BadRequest(new { error });

        return Results.Ok(new { status = "Processing" });
    }

    // Re-enrich metadata WITHOUT re-extracting chapters (that is /retry). Just flips the book back to
    // Pending; the worker's MetadataEnrichmentWorker sweep claims and runs it. Allowed on 'manual' books
    // (harmless — the executor's merge guard no-ops on user-edited fields).
    private static async Task<IResult> EnrichBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId.Value && b.Id == id, ct);
        if (book is null) return Results.NotFound();

        if (book.Status != UserBookStatus.Ready)
            return Results.BadRequest(new { error = "Book is not ready" });

        if (book.MetadataEnrichmentStatus is MetadataEnrichmentStatus.Pending or MetadataEnrichmentStatus.Running)
            return Results.BadRequest(new { error = "Enrichment already in progress" });

        book.MetadataEnrichmentStatus = MetadataEnrichmentStatus.Pending;
        book.MetadataEnrichmentAt = null;
        book.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Accepted(value: new { status = "Pending" });
    }

    private static async Task<IResult> CancelBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.CancelAsync(userId.Value, id, ct);
        if (!success)
            return Results.BadRequest(new { error });

        return Results.Ok(new { status = "Cancelled" });
    }

    private static async Task<IResult> DeleteBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.DeleteAsync(userId.Value, id, ct);
        if (!success)
            return Results.NotFound(new { error });

        return Results.NoContent();
    }
}
