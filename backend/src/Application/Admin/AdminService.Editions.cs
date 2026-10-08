using System.Security.Cryptography;
using System.Text.Json;
using Application.Collections;
using Application.Common.Interfaces;
using Contracts.Admin;
using Contracts.Common;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using Application.UserBooks;

namespace Application.Admin;

/// <summary>
/// Edition CRUD + publish workflow — stats, paginated listing with filters, detail load, update with SEO + authors + genres, delete (Draft only), publish (with search indexing + SSG rebuild), unpublish.
/// </summary>
public partial class AdminService
{
    // Edition CRUD

    public async Task<AdminStatsDto> GetStatsAsync(Guid? siteId, CancellationToken ct)
    {
        var editionQuery = db.Editions.AsQueryable();
        var authorQuery = db.Authors.AsQueryable();
        var chapterQuery = db.Chapters.AsQueryable();

        // Chapter is not ISiteScoped, so it carries no query filter of its own.
        // This query also references Edition nowhere else, so EF has no reason to
        // join editions and Edition's query filter cannot propagate here. The
        // explicit c.Edition.SiteId term is therefore required to keep the chapter
        // count site-scoped. (Contrast BookService.GetChapterAsync, where Edition
        // is already joined via Slug/Language/Status, so its query filter applies
        // and the manual term was dropped.)
        if (siteId.HasValue)
            chapterQuery = chapterQuery.Where(c => c.Edition.SiteId == siteId.Value);

        var totalEditions = await editionQuery.CountAsync(ct);
        var publishedEditions = await editionQuery.Where(e => e.Status == EditionStatus.Published).CountAsync(ct);
        var draftEditions = await editionQuery.Where(e => e.Status == EditionStatus.Draft).CountAsync(ct);
        var totalChapters = await chapterQuery.CountAsync(ct);
        var totalAuthors = await authorQuery.CountAsync(ct);
        var totalUsers = await db.Users.CountAsync(ct);

        return new AdminStatsDto(
            TotalEditions: totalEditions,
            PublishedEditions: publishedEditions,
            DraftEditions: draftEditions,
            TotalChapters: totalChapters,
            TotalAuthors: totalAuthors,
            TotalUsers: totalUsers
        );
    }

    public async Task<PaginatedResult<AdminEditionListDto>> GetEditionsAsync(
        Guid? siteId, int offset, int limit, EditionStatus? status, string? search, string? language, bool? indexable, bool? seoReady, string? sort, string? sortOrder, CancellationToken ct)
    {
        var query = db.Editions.AsQueryable();

        if (status.HasValue)
            query = query.Where(e => e.Status == status.Value);

        if (!string.IsNullOrWhiteSpace(search))
            query = query.Where(e => e.Title.Contains(search) || e.EditionAuthors.Any(ea => ea.Author.Name.Contains(search)));

        if (!string.IsNullOrWhiteSpace(language))
            query = query.Where(e => e.Language == language);

        if (indexable.HasValue)
        {
            if (indexable.Value)
                query = query.Where(e => e.Indexable && e.Status == EditionStatus.Published);
            else
                query = query.Where(e => !e.Indexable || e.Status != EditionStatus.Published);
        }

        if (seoReady.HasValue)
        {
            if (seoReady.Value)
                query = query.Where(e =>
                    e.Description != null && e.Description != "" &&
                    e.SeoRelevanceText != null && e.SeoRelevanceText != "" &&
                    e.SeoThemesJson != null && e.SeoThemesJson != "" &&
                    e.SeoFaqsJson != null && e.SeoFaqsJson != "" &&
                    e.Chapters.Any());
            else
                query = query.Where(e =>
                    e.Description == null || e.Description == "" ||
                    e.SeoRelevanceText == null || e.SeoRelevanceText == "" ||
                    e.SeoThemesJson == null || e.SeoThemesJson == "" ||
                    e.SeoFaqsJson == null || e.SeoFaqsJson == "" ||
                    !e.Chapters.Any());
        }

        var total = await query.CountAsync(ct);

        var sortField = (sort ?? "createdat").ToLowerInvariant();
        var isDesc = (sortOrder ?? "desc").ToLowerInvariant() == "desc";

        query = (sortField, isDesc) switch
        {
            ("title", false) => query.OrderBy(e => e.Title),
            ("title", true) => query.OrderByDescending(e => e.Title),
            ("createdat", false) => query.OrderBy(e => e.CreatedAt),
            _ => query.OrderByDescending(e => e.CreatedAt)
        };

        var items = await query
            .Skip(offset)
            .Take(limit)
            .Select(e => new AdminEditionListDto(
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                e.Status.ToString(),
                e.Chapters.Count,
                e.CreatedAt,
                e.PublishedAt,
                string.Join(", ", e.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name)),
                e.Description != null && e.Description != "" &&
                e.SeoRelevanceText != null && e.SeoRelevanceText != "" &&
                e.SeoThemesJson != null && e.SeoThemesJson != "" &&
                e.SeoFaqsJson != null && e.SeoFaqsJson != "" &&
                e.Chapters.Any(),
                e.FeaturedRank
            ))
            .ToListAsync(ct);

        return new PaginatedResult<AdminEditionListDto>(total, items);
    }

    public async Task<AdminEditionDetailDto?> GetEditionDetailAsync(Guid id, CancellationToken ct)
    {
        return await db.Editions
            .Where(e => e.Id == id)
            .Select(e => new AdminEditionDetailDto(
                e.Id,
                e.WorkId,
                e.SiteId,
                e.Slug,
                e.Title,
                e.Language,
                e.Description,
                e.CoverPath,
                e.Status.ToString(),
                e.IsPublicDomain,
                e.CreatedAt,
                e.PublishedAt,
                e.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new AdminChapterDto(c.Id, c.ChapterNumber, c.Slug ?? "", c.Title, c.WordCount))
                    .ToList(),
                e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new AdminEditionAuthorDto(ea.AuthorId, ea.Author.Slug, ea.Author.Name, ea.Order, ea.Role.ToString()))
                    .ToList(),
                e.Genres
                    .OrderBy(g => g.Name)
                    .Select(g => new AdminEditionGenreDto(g.Id, g.Slug, g.Name))
                    .ToList(),
                e.Indexable,
                e.SeoTitle,
                e.SeoDescription,
                e.CanonicalOverride,
                e.SeoRelevanceText,
                e.SeoThemesJson,
                e.SeoFaqsJson,
                e.FeaturedRank
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(bool Success, string? Error)> UpdateEditionAsync(
        Guid id, UpdateEditionRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return (false, "Title is required");

        if (request.Title.Length > 500)
            return (false, "Title must be 500 characters or less");

        if (request.Description?.Length > 5000)
            return (false, "Description must be 5000 characters or less");

        if (request.FeaturedRank is < 1 or > 999)
            return (false, "Featured rank must be between 1 and 999, or empty");

        var edition = await db.Editions.FindAsync([id], ct);
        if (edition is null)
            return (false, "Edition not found");

        edition.Title = request.Title;
        edition.Description = request.Description;
        edition.FeaturedRank = request.FeaturedRank;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        // SEO fields
        if (request.Indexable.HasValue)
            edition.Indexable = request.Indexable.Value;
        edition.SeoTitle = request.SeoTitle;
        edition.SeoDescription = request.SeoDescription;
        edition.CanonicalOverride = request.CanonicalOverride;

        // SEO content blocks
        edition.SeoRelevanceText = request.SeoRelevanceText;
        edition.SeoThemesJson = request.SeoThemesJson;
        edition.SeoFaqsJson = request.SeoFaqsJson;

        // Handle author assignment
        if (request.Authors is not null)
        {
            // Remove existing author associations
            var existingAuthors = await db.EditionAuthors
                .Where(ea => ea.EditionId == id)
                .ToListAsync(ct);
            db.EditionAuthors.RemoveRange(existingAuthors);

            // Add new author associations with order
            for (var i = 0; i < request.Authors.Count; i++)
            {
                var authorDto = request.Authors[i];
                var role = Enum.TryParse<AuthorRole>(authorDto.Role, true, out var parsedRole)
                    ? parsedRole
                    : AuthorRole.Author;

                db.EditionAuthors.Add(new EditionAuthor
                {
                    EditionId = id,
                    AuthorId = authorDto.AuthorId,
                    Order = i,
                    Role = role
                });
            }
        }

        // Handle genre assignment
        if (request.GenreIds is not null)
        {
            // Load edition with genres for M2M update
            var editionWithGenres = await db.Editions
                .Include(e => e.Genres)
                .FirstAsync(e => e.Id == id, ct);

            // Clear existing genres
            editionWithGenres.Genres.Clear();

            // Add new genres
            if (request.GenreIds.Count > 0)
            {
                var genres = await db.Genres
                    .Where(g => request.GenreIds.Contains(g.Id))
                    .ToListAsync(ct);

                foreach (var genre in genres)
                {
                    editionWithGenres.Genres.Add(genre);
                }
            }
        }

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> DeleteEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions
            .Include(e => e.BookFiles)
            .FirstOrDefaultAsync(e => e.Id == id, ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status == EditionStatus.Published)
            return (false, "Cannot delete published edition. Unpublish first.");

        // Chapters go by the database's edition cascade, in the same statement as the readers'
        // progress/bookmarks/notes — deleting them first would trip those rows' NO ACTION FKs.
        db.BookFiles.RemoveRange(edition.BookFiles);

        // Delete ingestion jobs
        var jobs = await db.IngestionJobs.Where(j => j.EditionId == id).ToListAsync(ct);
        db.IngestionJobs.RemoveRange(jobs);

        await CollectionService.RemoveFromAllCollectionsAsync(db, null, id, "savedbook", ct);
        db.Editions.Remove(edition);

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> PublishEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions.FirstOrDefaultAsync(e => e.Id == id, ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status == EditionStatus.Published)
            return (false, "Edition is already published");

        if (!await db.Chapters.AnyAsync(c => c.EditionId == id, ct))
            return (false, "Cannot publish edition with no chapters");

        edition.Status = EditionStatus.Published;
        edition.PublishedAt = DateTimeOffset.UtcNow;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        // No SSG enqueue (ADR-023): crawlers see the change after the nightly Full rebuild.
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> UnpublishEditionAsync(Guid id, CancellationToken ct)
    {
        var edition = await db.Editions.FindAsync([id], ct);

        if (edition is null)
            return (false, "Edition not found");

        if (edition.Status != EditionStatus.Published)
            return (false, "Edition is not published");

        edition.Status = EditionStatus.Draft;
        edition.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }
}
