using Api.Language;
using Api.Sites;
using Application.Books;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class BooksEndpoints
{
    public static void MapBooksEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/books").WithTags("Books");

        group.MapGet("", GetBooks).WithName("GetBooks");
        group.MapGet("/{slug}", GetBook).WithName("GetBook");
        group.MapGet("/{slug}/chapters/{chapterSlug}", GetChapter).WithName("GetChapter");
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
}
