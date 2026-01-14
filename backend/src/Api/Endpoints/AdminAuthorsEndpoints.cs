using Application.Common.Interfaces;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class AdminAuthorsEndpoints
{
    public static void MapAdminAuthorsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/authors").WithTags("Admin Authors");

        group.MapGet("", GetAuthors)
            .WithName("AdminGetAuthors")
            .WithDescription("List authors with pagination");

        group.MapGet("/stats", GetAuthorStats)
            .WithName("AdminGetAuthorStats")
            .WithDescription("Get author statistics");

        group.MapGet("/search", SearchAuthors)
            .WithName("SearchAuthors")
            .WithDescription("Search authors by name for autocomplete");

        group.MapGet("/{id:guid}", GetAuthorById)
            .WithName("AdminGetAuthorById")
            .WithDescription("Get author detail with books");

        group.MapPost("", CreateAuthor)
            .WithName("AdminCreateAuthor")
            .WithDescription("Create a new author or return existing if exact match");

        group.MapPut("/{id:guid}", UpdateAuthor)
            .WithName("AdminUpdateAuthor")
            .WithDescription("Update author details");

        group.MapDelete("/{id:guid}", DeleteAuthor)
            .WithName("AdminDeleteAuthor")
            .WithDescription("Delete author (only if no books)");

        group.MapPost("/{id:guid}/photo", UploadAuthorPhoto)
            .WithName("AdminUploadAuthorPhoto")
            .WithDescription("Upload author photo (max 2MB, JPG/PNG only)")
            .DisableAntiforgery();
    }

    private static async Task<IResult> GetAuthorStats(
        IAppDbContext db,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var authors = db.Authors.Where(a => a.SiteId == siteId.Value);

        var total = await authors.CountAsync(ct);

        var withPublished = await authors
            .CountAsync(a => a.EditionAuthors.Any(ea => ea.Edition.Status == EditionStatus.Published), ct);

        var totalBooks = await authors
            .SumAsync(a => a.EditionAuthors.Count, ct);

        return Results.Ok(new AdminAuthorStatsDto(
            Total: total,
            WithPublishedBooks: withPublished,
            WithoutPublishedBooks: total - withPublished,
            TotalBooks: totalBooks
        ));
    }

    private static async Task<IResult> SearchAuthors(
        IAppDbContext db,
        [FromQuery] string? q,
        [FromQuery] Guid? siteId,
        [FromQuery] int? limit,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var take = Math.Min(limit ?? 10, 20);

        var query = db.Authors
            .Where(a => a.SiteId == siteId.Value);

        if (!string.IsNullOrWhiteSpace(q))
        {
            query = query.Where(a => EF.Functions.ILike(a.Name, $"%{q}%"));
        }

        var items = await query
            .OrderBy(a => a.Name)
            .Take(take)
            .Select(a => new AdminAuthorSearchResultDto(
                a.Id,
                a.Slug,
                a.Name,
                a.EditionAuthors.Count(ea => ea.Edition.Status == EditionStatus.Published)
            ))
            .ToListAsync(ct);

        return Results.Ok(items);
    }

    private static async Task<IResult> CreateAuthor(
        IAppDbContext db,
        [FromBody] CreateAuthorRequest req,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Name is required" });

        var trimmedName = req.Name.Trim();

        // Check for existing author with exact name (case-insensitive)
        var existing = await db.Authors
            .FirstOrDefaultAsync(a => a.SiteId == req.SiteId && a.Name.ToLower() == trimmedName.ToLower(), ct);

        if (existing is not null)
        {
            return Results.Ok(new CreateAuthorResponse(existing.Id, existing.Slug, existing.Name, IsNew: false));
        }

        // Generate unique slug
        var baseSlug = SlugGenerator.GenerateSlug(trimmedName);
        var slug = baseSlug;
        var suffix = 2;

        while (await db.Authors.AnyAsync(a => a.SiteId == req.SiteId && a.Slug == slug, ct))
        {
            slug = $"{baseSlug}-{suffix}";
            suffix++;
        }

        var now = DateTimeOffset.UtcNow;
        var author = new Author
        {
            Id = Guid.NewGuid(),
            SiteId = req.SiteId,
            Slug = slug,
            Name = trimmedName,
            CreatedAt = now,
            UpdatedAt = now
        };

        db.Authors.Add(author);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/admin/authors/{author.Id}",
            new CreateAuthorResponse(author.Id, author.Slug, author.Name, IsNew: true));
    }

    private static async Task<IResult> GetAuthors(
        IAppDbContext db,
        [FromQuery] Guid? siteId,
        [FromQuery] int? offset,
        [FromQuery] int? limit,
        [FromQuery] string? search,
        [FromQuery] bool? hasPublishedBooks,
        CancellationToken ct)
    {
        if (siteId is null)
            return Results.BadRequest(new { error = "siteId is required" });

        var skip = offset ?? 0;
        var take = Math.Min(limit ?? 20, 100);

        var query = db.Authors.Where(a => a.SiteId == siteId.Value);

        if (!string.IsNullOrWhiteSpace(search))
            query = query.Where(a => EF.Functions.ILike(a.Name, $"%{search}%"));

        if (hasPublishedBooks.HasValue)
        {
            if (hasPublishedBooks.Value)
                query = query.Where(a => a.EditionAuthors.Any(ea => ea.Edition.Status == EditionStatus.Published));
            else
                query = query.Where(a => !a.EditionAuthors.Any(ea => ea.Edition.Status == EditionStatus.Published));
        }

        var total = await query.CountAsync(ct);

        var items = await query
            .OrderBy(a => a.Name)
            .Skip(skip)
            .Take(take)
            .Select(a => new AdminAuthorListDto(
                a.Id,
                a.Slug,
                a.Name,
                a.PhotoPath,
                a.EditionAuthors.Count,
                a.EditionAuthors.Any(ea => ea.Edition.Status == EditionStatus.Published),
                a.CreatedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetAuthorById(
        IAppDbContext db,
        Guid id,
        CancellationToken ct)
    {
        var author = await db.Authors
            .Where(a => a.Id == id)
            .Select(a => new AdminAuthorDetailDto(
                a.Id,
                a.SiteId,
                a.Slug,
                a.Name,
                a.Bio,
                a.PhotoPath,
                a.Indexable,
                a.SeoTitle,
                a.SeoDescription,
                a.EditionAuthors.Count,
                a.CreatedAt,
                a.EditionAuthors
                    .OrderByDescending(ea => ea.Edition.CreatedAt)
                    .Select(ea => new AdminAuthorBookDto(
                        ea.EditionId,
                        ea.Edition.Slug,
                        ea.Edition.Title,
                        ea.Role.ToString(),
                        ea.Edition.Status.ToString()
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);

        if (author is null)
            return Results.NotFound(new { error = "Author not found" });

        return Results.Ok(author);
    }

    private static async Task<IResult> UpdateAuthor(
        IAppDbContext db,
        Guid id,
        [FromBody] UpdateAuthorRequest req,
        CancellationToken ct)
    {
        var author = await db.Authors.FindAsync([id], ct);
        if (author is null)
            return Results.NotFound(new { error = "Author not found" });

        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Name is required" });

        var trimmedName = req.Name.Trim();

        // Check for duplicate name (case-insensitive, exclude current author)
        var duplicate = await db.Authors
            .AnyAsync(a => a.SiteId == author.SiteId && a.Id != id && a.Name.ToLower() == trimmedName.ToLower(), ct);
        if (duplicate)
            return Results.BadRequest(new { error = "An author with this name already exists" });

        // Update slug if name changed
        if (!author.Name.Equals(trimmedName, StringComparison.OrdinalIgnoreCase))
        {
            var baseSlug = SlugGenerator.GenerateSlug(trimmedName);
            var slug = baseSlug;
            var suffix = 2;
            while (await db.Authors.AnyAsync(a => a.SiteId == author.SiteId && a.Id != id && a.Slug == slug, ct))
            {
                slug = $"{baseSlug}-{suffix}";
                suffix++;
            }
            author.Slug = slug;
        }

        author.Name = trimmedName;
        author.Bio = req.Bio;
        author.UpdatedAt = DateTimeOffset.UtcNow;

        if (req.Indexable.HasValue)
            author.Indexable = req.Indexable.Value;
        author.SeoTitle = req.SeoTitle;
        author.SeoDescription = req.SeoDescription;

        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> DeleteAuthor(
        IAppDbContext db,
        Guid id,
        CancellationToken ct)
    {
        var author = await db.Authors
            .Include(a => a.EditionAuthors)
            .FirstOrDefaultAsync(a => a.Id == id, ct);

        if (author is null)
            return Results.NotFound(new { error = "Author not found" });

        if (author.EditionAuthors.Count > 0)
            return Results.BadRequest(new { error = "Cannot delete author with books. Remove author from all books first." });

        db.Authors.Remove(author);
        await db.SaveChangesAsync(ct);

        return Results.Ok();
    }

    private static readonly string[] AllowedPhotoExtensions = [".jpg", ".jpeg", ".png"];
    private const long MaxPhotoSize = 2 * 1024 * 1024; // 2MB

    private static async Task<IResult> UploadAuthorPhoto(
        IAppDbContext db,
        IFileStorageService storage,
        Guid id,
        IFormFile file,
        CancellationToken ct)
    {
        var author = await db.Authors.FindAsync([id], ct);
        if (author is null)
            return Results.NotFound(new { error = "Author not found" });

        if (file.Length == 0)
            return Results.BadRequest(new { error = "File is empty" });

        if (file.Length > MaxPhotoSize)
            return Results.BadRequest(new { error = "File too large. Max 2MB allowed" });

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!AllowedPhotoExtensions.Contains(ext))
            return Results.BadRequest(new { error = "Invalid file type. Only JPG and PNG allowed" });

        // Delete old photo if exists
        if (!string.IsNullOrEmpty(author.PhotoPath))
        {
            await storage.DeleteFileAsync(author.PhotoPath, ct);
        }

        // Save new photo - use authors/{id}/photo.ext pattern
        await using var stream = file.OpenReadStream();
        var fileName = $"photo{ext}";
        var relativePath = await storage.SaveFileAsync(id, fileName, stream, ct);

        author.PhotoPath = relativePath;
        author.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { photoPath = relativePath });
    }
}
