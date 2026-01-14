using Application.Common.Interfaces;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class AdminGenresEndpoints
{
    public static void MapAdminGenresEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/genres").WithTags("Admin Genres");

        group.MapGet("", GetGenres)
            .WithName("AdminGetGenres")
            .WithDescription("List genres with pagination");

        group.MapGet("/stats", GetGenreStats)
            .WithName("AdminGetGenreStats")
            .WithDescription("Get genre statistics");

        group.MapGet("/search", SearchGenres)
            .WithName("SearchGenres")
            .WithDescription("Search genres by name for autocomplete");

        group.MapGet("/{id:guid}", GetGenreById)
            .WithName("AdminGetGenreById")
            .WithDescription("Get genre detail with editions");

        group.MapPost("", CreateGenre)
            .WithName("AdminCreateGenre")
            .WithDescription("Create a new genre or return existing if exact match");

        group.MapPut("/{id:guid}", UpdateGenre)
            .WithName("AdminUpdateGenre")
            .WithDescription("Update genre details");

        group.MapDelete("/{id:guid}", DeleteGenre)
            .WithName("AdminDeleteGenre")
            .WithDescription("Delete genre (only if no editions)");
    }

    private static async Task<IResult> GetGenreStats(
        IAppDbContext db,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var genres = db.Genres.Where(g => g.SiteId == siteId.Value);

        var total = await genres.CountAsync(ct);

        var withPublished = await genres
            .CountAsync(g => g.Editions.Any(e => e.Status == EditionStatus.Published), ct);

        var totalEditions = await genres
            .SumAsync(g => g.Editions.Count, ct);

        return Results.Ok(new AdminGenreStatsDto(
            Total: total,
            WithPublishedBooks: withPublished,
            WithoutPublishedBooks: total - withPublished,
            TotalEditions: totalEditions
        ));
    }

    private static async Task<IResult> SearchGenres(
        IAppDbContext db,
        [FromQuery] string? q,
        [FromQuery] Guid? siteId,
        [FromQuery] int? limit,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var take = Math.Min(limit ?? 10, 20);

        var query = db.Genres
            .Where(g => g.SiteId == siteId.Value);

        if (!string.IsNullOrWhiteSpace(q))
        {
            query = query.Where(g => EF.Functions.ILike(g.Name, $"%{q}%"));
        }

        var items = await query
            .OrderBy(g => g.Name)
            .Take(take)
            .Select(g => new AdminGenreSearchResultDto(
                g.Id,
                g.Slug,
                g.Name,
                g.Editions.Count(e => e.Status == EditionStatus.Published)
            ))
            .ToListAsync(ct);

        return Results.Ok(items);
    }

    private static async Task<IResult> CreateGenre(
        IAppDbContext db,
        [FromBody] CreateGenreRequest req,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Name is required" });

        var trimmedName = req.Name.Trim();

        // Check for existing genre with exact name (case-insensitive)
        var existing = await db.Genres
            .FirstOrDefaultAsync(g => g.SiteId == req.SiteId && g.Name.ToLower() == trimmedName.ToLower(), ct);

        if (existing is not null)
        {
            return Results.Ok(new CreateGenreResponse(existing.Id, existing.Slug, existing.Name, IsNew: false));
        }

        // Generate unique slug
        var baseSlug = SlugGenerator.GenerateSlug(trimmedName);
        var slug = baseSlug;
        var suffix = 2;

        while (await db.Genres.AnyAsync(g => g.SiteId == req.SiteId && g.Slug == slug, ct))
        {
            slug = $"{baseSlug}-{suffix}";
            suffix++;
        }

        var now = DateTimeOffset.UtcNow;
        var genre = new Genre
        {
            Id = Guid.NewGuid(),
            SiteId = req.SiteId,
            Slug = slug,
            Name = trimmedName,
            CreatedAt = now,
            UpdatedAt = now
        };

        db.Genres.Add(genre);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/admin/genres/{genre.Id}",
            new CreateGenreResponse(genre.Id, genre.Slug, genre.Name, IsNew: true));
    }

    private static async Task<IResult> GetGenres(
        IAppDbContext db,
        [FromQuery] Guid? siteId,
        [FromQuery] int? offset,
        [FromQuery] int? limit,
        [FromQuery] string? search,
        [FromQuery] bool? indexable,
        [FromQuery] bool? hasPublishedBooks,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var skip = offset ?? 0;
        var take = Math.Min(limit ?? 20, 100);

        var query = db.Genres.Where(g => g.SiteId == siteId.Value);

        if (!string.IsNullOrWhiteSpace(search))
            query = query.Where(g => EF.Functions.ILike(g.Name, $"%{search}%")
                                  || EF.Functions.ILike(g.Slug, $"%{search}%"));

        if (indexable.HasValue)
            query = query.Where(g => g.Indexable == indexable.Value);

        if (hasPublishedBooks.HasValue)
        {
            if (hasPublishedBooks.Value)
                query = query.Where(g => g.Editions.Any(e => e.Status == EditionStatus.Published));
            else
                query = query.Where(g => !g.Editions.Any(e => e.Status == EditionStatus.Published));
        }

        var total = await query.CountAsync(ct);

        var items = await query
            .OrderBy(g => g.Name)
            .Skip(skip)
            .Take(take)
            .Select(g => new AdminGenreListDto(
                g.Id,
                g.Slug,
                g.Name,
                g.Description,
                g.Indexable,
                g.Editions.Count,
                g.Editions.Any(e => e.Status == EditionStatus.Published),
                g.UpdatedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetGenreById(
        IAppDbContext db,
        Guid id,
        CancellationToken ct)
    {
        var genre = await db.Genres
            .Where(g => g.Id == id)
            .Select(g => new AdminGenreDetailDto(
                g.Id,
                g.SiteId,
                g.Slug,
                g.Name,
                g.Description,
                g.Indexable,
                g.SeoTitle,
                g.SeoDescription,
                g.Editions.Count,
                g.CreatedAt,
                g.UpdatedAt,
                g.Editions
                    .OrderByDescending(e => e.CreatedAt)
                    .Select(e => new AdminGenreEditionDto(
                        e.Id,
                        e.Slug,
                        e.Title,
                        e.Status.ToString()
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);

        if (genre is null)
            return Results.NotFound(new { error = "Genre not found" });

        return Results.Ok(genre);
    }

    private static async Task<IResult> UpdateGenre(
        IAppDbContext db,
        Guid id,
        [FromBody] UpdateGenreRequest req,
        CancellationToken ct)
    {
        var genre = await db.Genres.FindAsync([id], ct);
        if (genre is null)
            return Results.NotFound(new { error = "Genre not found" });

        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Name is required" });

        var trimmedName = req.Name.Trim();

        // Check for duplicate name (case-insensitive, exclude current genre)
        var duplicate = await db.Genres
            .AnyAsync(g => g.SiteId == genre.SiteId && g.Id != id && g.Name.ToLower() == trimmedName.ToLower(), ct);
        if (duplicate)
            return Results.BadRequest(new { error = "A genre with this name already exists" });

        // Update slug if name changed
        if (!genre.Name.Equals(trimmedName, StringComparison.OrdinalIgnoreCase))
        {
            var baseSlug = SlugGenerator.GenerateSlug(trimmedName);
            var slug = baseSlug;
            var suffix = 2;
            while (await db.Genres.AnyAsync(g => g.SiteId == genre.SiteId && g.Id != id && g.Slug == slug, ct))
            {
                slug = $"{baseSlug}-{suffix}";
                suffix++;
            }
            genre.Slug = slug;
        }

        genre.Name = trimmedName;
        genre.Description = req.Description;
        genre.UpdatedAt = DateTimeOffset.UtcNow;

        if (req.Indexable.HasValue)
            genre.Indexable = req.Indexable.Value;
        genre.SeoTitle = req.SeoTitle;
        genre.SeoDescription = req.SeoDescription;

        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> DeleteGenre(
        IAppDbContext db,
        Guid id,
        CancellationToken ct)
    {
        var genre = await db.Genres
            .Include(g => g.Editions)
            .FirstOrDefaultAsync(g => g.Id == id, ct);

        if (genre is null)
            return Results.NotFound(new { error = "Genre not found" });

        if (genre.Editions.Count > 0)
            return Results.BadRequest(new { error = "Cannot delete genre with editions. Remove genre from all editions first." });

        db.Genres.Remove(genre);
        await db.SaveChangesAsync(ct);

        return Results.Ok();
    }
}
