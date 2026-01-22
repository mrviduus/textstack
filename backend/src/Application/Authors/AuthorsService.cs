using Application.Common.Interfaces;
using Contracts.Authors;
using Contracts.Common;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.Authors;

public class AuthorsService(IAppDbContext db)
{
    public async Task<PaginatedResult<AuthorListDto>> GetAuthorsAsync(
        Guid siteId, int offset, int limit, string? language, string? sort, CancellationToken ct)
    {
        var query = db.Authors
            .Where(a => a.SiteId == siteId && a.Indexable)
            .Where(a => a.EditionAuthors.Any(ea => ea.Edition.Status == EditionStatus.Published));

        if (!string.IsNullOrEmpty(language))
        {
            query = query.Where(a => a.EditionAuthors.Any(ea =>
                ea.Edition.Language == language &&
                ea.Edition.Status == EditionStatus.Published));
        }

        query = sort == "recent"
            ? query.OrderByDescending(a => a.CreatedAt)
            : query.OrderBy(a => a.Name);

        var total = await query.CountAsync(ct);

        var items = await query
            .Skip(offset)
            .Take(limit)
            .Select(a => new AuthorListDto(
                a.Id,
                a.Slug,
                a.Name,
                a.PhotoPath,
                string.IsNullOrEmpty(language)
                    ? a.EditionAuthors.Count(ea => ea.Edition.Status == EditionStatus.Published)
                    : a.EditionAuthors.Count(ea => ea.Edition.Language == language && ea.Edition.Status == EditionStatus.Published)
            ))
            .ToListAsync(ct);

        return new PaginatedResult<AuthorListDto>(total, items);
    }

    public async Task<AuthorDetailDto?> GetAuthorAsync(Guid siteId, string slug, CancellationToken ct)
    {
        var author = await db.Authors
            .Where(a => a.SiteId == siteId && a.Slug == slug)
            .Select(a => new AuthorDetailDto(
                a.Id,
                a.Slug,
                a.Name,
                a.Bio,
                a.PhotoPath,
                a.SeoTitle,
                a.SeoDescription,
                a.EditionAuthors
                    .Where(ea => ea.Edition.Status == EditionStatus.Published)
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new AuthorEditionDto(
                        ea.Edition.Id,
                        ea.Edition.Slug,
                        ea.Edition.Title,
                        ea.Edition.Language,
                        ea.Edition.CoverPath
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);

        // Return null if author doesn't exist OR has no published editions
        if (author is null || author.Editions.Count == 0)
            return null;

        return author;
    }
}
