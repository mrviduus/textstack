using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class HighlightsEndpoints
{
    public static void MapHighlightsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/highlights").WithTags("Highlights");

        group.MapGet("/{editionId:guid}", GetHighlights).WithName("GetHighlights");
        group.MapPost("", CreateHighlight).WithName("CreateHighlight");
        group.MapPut("/{id:guid}", UpdateHighlight).WithName("UpdateHighlight");
        group.MapDelete("/{id:guid}", DeleteHighlight).WithName("DeleteHighlight");
    }

    private static Guid? GetUserId(HttpContext httpContext, AuthService authService)
    {
        var accessToken = httpContext.Request.Cookies["access_token"];
        if (string.IsNullOrEmpty(accessToken)) return null;
        return authService.ValidateAccessToken(accessToken);
    }

    private static async Task<IResult> GetHighlights(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        var highlights = await db.Highlights
            .Where(h => h.UserId == userId.Value && h.SiteId == siteId && h.EditionId == editionId)
            .OrderByDescending(h => h.CreatedAt)
            .Select(h => new HighlightDto(
                h.Id,
                h.EditionId,
                h.ChapterId,
                h.AnchorJson,
                h.Color,
                h.SelectedText,
                h.NoteText,
                h.Version,
                h.CreatedAt,
                h.UpdatedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(highlights);
    }

    private static async Task<IResult> CreateHighlight(
        [FromBody] CreateHighlightRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        // Validate edition exists
        var edition = await db.Editions
            .Where(e => e.Id == request.EditionId && e.SiteId == siteId)
            .FirstOrDefaultAsync(ct);

        if (edition == null) return Results.NotFound("Edition not found");

        // Validate chapter exists
        var chapter = await db.Chapters
            .Where(c => c.Id == request.ChapterId && c.EditionId == request.EditionId)
            .FirstOrDefaultAsync(ct);

        if (chapter == null) return Results.NotFound("Chapter not found");

        var now = DateTimeOffset.UtcNow;
        var highlight = new Highlight
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = siteId,
            EditionId = request.EditionId,
            ChapterId = request.ChapterId,
            AnchorJson = request.AnchorJson,
            Color = request.Color,
            SelectedText = request.SelectedText,
            NoteText = request.NoteText,
            Version = 1,
            CreatedAt = now,
            UpdatedAt = now
        };

        db.Highlights.Add(highlight);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/me/highlights/{highlight.Id}", new HighlightDto(
            highlight.Id,
            highlight.EditionId,
            highlight.ChapterId,
            highlight.AnchorJson,
            highlight.Color,
            highlight.SelectedText,
            highlight.NoteText,
            highlight.Version,
            highlight.CreatedAt,
            highlight.UpdatedAt
        ));
    }

    private static async Task<IResult> UpdateHighlight(
        Guid id,
        [FromBody] UpdateHighlightRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var highlight = await db.Highlights
            .Where(h => h.Id == id && h.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (highlight == null) return Results.NotFound();

        // Conflict resolution: only update if client version matches
        if (request.Version.HasValue && request.Version.Value != highlight.Version)
        {
            return Results.Conflict(new HighlightDto(
                highlight.Id,
                highlight.EditionId,
                highlight.ChapterId,
                highlight.AnchorJson,
                highlight.Color,
                highlight.SelectedText,
                highlight.NoteText,
                highlight.Version,
                highlight.CreatedAt,
                highlight.UpdatedAt
            ));
        }

        if (request.Color != null)
            highlight.Color = request.Color;
        if (request.AnchorJson != null)
            highlight.AnchorJson = request.AnchorJson;
        if (request.SelectedText != null)
            highlight.SelectedText = request.SelectedText;
        // NoteText can be set to null to remove the note, so we check if it was provided in request
        highlight.NoteText = request.NoteText;

        highlight.Version++;
        highlight.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        return Results.Ok(new HighlightDto(
            highlight.Id,
            highlight.EditionId,
            highlight.ChapterId,
            highlight.AnchorJson,
            highlight.Color,
            highlight.SelectedText,
            highlight.NoteText,
            highlight.Version,
            highlight.CreatedAt,
            highlight.UpdatedAt
        ));
    }

    private static async Task<IResult> DeleteHighlight(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var highlight = await db.Highlights
            .Where(h => h.Id == id && h.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (highlight == null) return Results.NotFound();

        db.Highlights.Remove(highlight);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }
}

// DTOs
public record HighlightDto(
    Guid Id,
    Guid EditionId,
    Guid ChapterId,
    string AnchorJson,
    string Color,
    string SelectedText,
    string? NoteText,
    int Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public record CreateHighlightRequest(
    Guid EditionId,
    Guid ChapterId,
    string AnchorJson,
    string Color,
    string SelectedText,
    string? NoteText = null
);

public record UpdateHighlightRequest(
    string? Color,
    string? AnchorJson,
    string? SelectedText,
    string? NoteText,
    int? Version
);
