using Api.Language;
using Api.Sites;
using Application.Books;
using Application.Common.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class BooksEndpoints
{
    public static void MapBooksEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/books").WithTags("Books");

        group.MapGet("", GetBooks).WithName("GetBooks");
        group.MapGet("/{slug}", GetBook).WithName("GetBook");
        group.MapGet("/{slug}/chapters/{chapterSlug}", GetChapter).WithName("GetChapter");
        group.MapGet("/{editionId:guid}/assets/{assetId:guid}", GetAsset).WithName("GetAsset");
    }

    private static async Task<IResult> GetBooks(
        HttpContext httpContext,
        BookService bookService,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var language = httpContext.GetLanguage();
        var result = await bookService.GetBooksAsync(siteId, offset ?? 0, limit ?? 20, language, ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> GetBook(
        string slug,
        HttpContext httpContext,
        BookService bookService,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var language = httpContext.GetLanguage();
        var book = await bookService.GetBookAsync(siteId, slug, language, ct);

        if (book is null)
        {
            var actualLang = await bookService.FindBookLanguageAsync(siteId, slug, ct);
            if (actualLang is not null && actualLang != language)
            {
                var encodedSlug = Uri.EscapeDataString(slug);
                return Results.Redirect($"/{actualLang}/books/{encodedSlug}", permanent: false);
            }
            return Results.NotFound();
        }

        // Return 404 if book has no chapters (no readable content)
        if (book.Chapters.Count == 0)
            return Results.NotFound();

        return Results.Ok(book);
    }

    private static async Task<IResult> GetChapter(
        string slug,
        string chapterSlug,
        HttpContext httpContext,
        BookService bookService,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var language = httpContext.GetLanguage();
        var chapter = await bookService.GetChapterAsync(siteId, slug, chapterSlug, language, ct);

        if (chapter is null)
        {
            var actualLang = await bookService.FindBookLanguageAsync(siteId, slug, ct);
            if (actualLang is not null && actualLang != language)
            {
                var encodedSlug = Uri.EscapeDataString(slug);
                var encodedChapterSlug = Uri.EscapeDataString(chapterSlug);
                return Results.Redirect($"/{actualLang}/books/{encodedSlug}/{encodedChapterSlug}", permanent: false);
            }
            return Results.NotFound();
        }

        return Results.Ok(chapter);
    }

    private static async Task<IResult> GetAsset(
        Guid editionId,
        Guid assetId,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var asset = await db.BookAssets
            .FirstOrDefaultAsync(a => a.Id == assetId && a.EditionId == editionId, ct);

        if (asset is null)
            return Results.NotFound();

        var stream = await storage.GetFileAsync(asset.StoragePath, ct);
        if (stream is null)
            return Results.NotFound();

        return Results.File(stream, asset.ContentType);
    }
}
