using Api.Extensions;
using Api.V2;
using Application.Annotations;
using Application.Auth;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

/// <summary>
/// M5.1 Part C (docs/internal/v2/m5-part-c-routes.md): the legacy routes the new clients still call, answered from
/// V2 in <c>Database:Mode=v2</c>. Mapped only in v2 mode, on the legacy path and shape, ordered before the legacy
/// handler (<c>WithOrder(-1)</c>), so legacy mode maps and runs exactly what it did. Behind <see cref="V2Gate"/>
/// like every <c>/me/v2</c> route. Goes at M6 with the legacy handlers.
/// </summary>
public static class V2CompatEndpoints
{
    public static void MapV2CompatEndpoints(this WebApplication app)
    {
        if (!app.Services.GetRequiredService<DatabaseMode>().IsV2) return;

        var highlights = app.MapGroup("/me/highlights").WithMetadata(V2SelectedRoute.Instance).WithTags("Highlights").AddEndpointFilter<V2Gate>();
        highlights.MapGet("/all", GetAllHighlights).WithOrder(-1);
    }

    /// <summary>
    /// <c>GET /me/highlights/all</c> on V2 annotations, the legacy query and shape. A V2 highlight is in an upload
    /// (no catalog editions): <c>bookType=edition</c> lists none; covers are not served here (null).
    /// </summary>
    private static async Task<IResult> GetAllHighlights(
        HttpContext http, IAuthService auth, IAnnotationRepository annotations,
        [FromQuery] int limit = 50, [FromQuery] int offset = 0, [FromQuery] string? bookType = "all",
        [FromQuery] string? sort = "newest", [FromQuery] string? search = null, [FromQuery] string? color = null,
        CancellationToken ct = default)
    {
        if (bookType == "edition") return Results.Ok(new { items = Array.Empty<HighlightListItemDto>(), totalCount = 0 });

        var page = await annotations.ListAllAsync(http.GetUserId(auth)!.Value, search, color, sort == "oldest",
            Math.Clamp(limit, 1, 100), Math.Max(offset, 0), ct);
        var items = page.Items.Select(h => new HighlightListItemDto(
            h.Id, h.SelectedText, h.AnchorJson, h.Color, h.NoteText, h.CreatedAt,
            null, null, null, null,
            // A removed book's highlight carries only the title it had, as legacy's deleted book (#982).
            h.BookRemoved ? null : h.BookId, h.BookRemoved ? null : h.BookTitle, null,
            null, h.ChapterId, null, h.ChapterTitle, null, h.ChapterKey,
            h.BookRemoved ? h.BookTitle : null));
        return Results.Ok(new { items, totalCount = page.TotalCount });
    }
}
