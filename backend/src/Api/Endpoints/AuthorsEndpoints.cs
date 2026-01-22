using Api.Sites;
using Application.Authors;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AuthorsEndpoints
{
    public static void MapAuthorsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/authors").WithTags("Authors");

        group.MapGet("", GetAuthors).WithName("GetAuthors");
        group.MapGet("/{slug}", GetAuthor).WithName("GetAuthor");
    }

    private static async Task<IResult> GetAuthors(
        HttpContext httpContext,
        AuthorsService authorsService,
        [FromQuery] string? language,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? sort,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var take = Math.Min(limit ?? 50, 100);
        var skip = offset ?? 0;

        var result = await authorsService.GetAuthorsAsync(siteId, skip, take, language, sort, ct);
        return Results.Ok(new { total = result.Total, items = result.Items });
    }

    private static async Task<IResult> GetAuthor(
        HttpContext httpContext,
        AuthorsService authorsService,
        string slug,
        CancellationToken ct)
    {
        var siteId = httpContext.GetSiteId();
        var author = await authorsService.GetAuthorAsync(siteId, slug, ct);

        if (author is null)
            return Results.NotFound();

        return Results.Ok(author);
    }
}
