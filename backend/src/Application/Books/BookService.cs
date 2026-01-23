using Application.Common.Interfaces;
using Contracts.Books;
using Contracts.Common;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.Books;

public class BookService(IAppDbContext db)
{
    public async Task<PaginatedResult<BookListDto>> GetBooksAsync(
        Guid siteId, int offset, int limit, string? language, CancellationToken ct)
    {
        var query = db.Editions
            .Where(e => e.SiteId == siteId && e.Status == EditionStatus.Published)
            // Only show books with at least one chapter
            .Where(e => e.Chapters.Any())
            .AsQueryable();

        if (!string.IsNullOrEmpty(language))
            query = query.Where(e => e.Language == language);

        var total = await query.CountAsync(ct);

        var books = await query
            .OrderByDescending(e => e.PublishedAt ?? e.CreatedAt)
            .Skip(offset)
            .Take(limit)
            .Select(e => new BookListDto(
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                e.Description,
                e.CoverPath,
                e.PublishedAt,
                e.Chapters.Count,
                e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new BookAuthorDto(
                        ea.Author.Id,
                        ea.Author.Slug,
                        ea.Author.Name,
                        ea.Role.ToString()
                    ))
                    .ToList()
            ))
            .ToListAsync(ct);

        return new PaginatedResult<BookListDto>(total, books);
    }

    public async Task<BookDetailDto?> GetBookAsync(Guid siteId, string slug, string language, CancellationToken ct)
    {
        return await db.Editions
            .Where(e => e.SiteId == siteId && e.Slug == slug && e.Language == language && e.Status == EditionStatus.Published)
            .Select(e => new BookDetailDto(
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                e.Description,
                e.CoverPath,
                e.PublishedAt,
                e.IsPublicDomain,
                e.SeoTitle,
                e.SeoDescription,
                new WorkDto(e.Work.Id, e.Work.Slug),
                e.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new ChapterSummaryDto(
                        c.Id,
                        c.ChapterNumber,
                        c.Slug,
                        c.Title,
                        c.WordCount
                    ))
                    .ToList(),
                e.Work.Editions
                    .Where(oe => oe.Id != e.Id && oe.Status == EditionStatus.Published)
                    .Select(oe => new EditionSummaryDto(oe.Id, oe.Slug, oe.Language, oe.Title))
                    .ToList(),
                e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new BookAuthorDto(
                        ea.Author.Id,
                        ea.Author.Slug,
                        ea.Author.Name,
                        ea.Role.ToString()
                    ))
                    .ToList()
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<string?> FindBookLanguageAsync(Guid siteId, string slug, CancellationToken ct)
    {
        return await db.Editions
            .Where(e => e.SiteId == siteId && e.Slug == slug && e.Status == EditionStatus.Published)
            .Select(e => e.Language)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<ChapterDto?> GetChapterAsync(
        Guid siteId, string bookSlug, string chapterSlug, string language, CancellationToken ct)
    {
        var chapter = await db.Chapters
            .Where(c => c.Edition.SiteId == siteId
                && c.Edition.Slug == bookSlug
                && c.Edition.Language == language
                && c.Slug == chapterSlug
                && c.Edition.Status == EditionStatus.Published)
            .Select(c => new
            {
                c.Id,
                c.ChapterNumber,
                c.Slug,
                c.Title,
                c.Html,
                c.WordCount,
                c.EditionId,
                Edition = new ChapterEditionDto(
                    c.Edition.Id,
                    c.Edition.Slug,
                    c.Edition.Title,
                    c.Edition.Language
                )
            })
            .FirstOrDefaultAsync(ct);

        if (chapter is null)
            return null;

        var prev = await db.Chapters
            .Where(p => p.EditionId == chapter.EditionId && p.ChapterNumber == chapter.ChapterNumber - 1)
            .Select(p => new ChapterNavDto(p.Slug, p.Title))
            .FirstOrDefaultAsync(ct);

        var next = await db.Chapters
            .Where(n => n.EditionId == chapter.EditionId && n.ChapterNumber == chapter.ChapterNumber + 1)
            .Select(n => new ChapterNavDto(n.Slug, n.Title))
            .FirstOrDefaultAsync(ct);

        return new ChapterDto(
            chapter.Id,
            chapter.ChapterNumber,
            chapter.Slug,
            chapter.Title,
            chapter.Html,
            chapter.WordCount,
            chapter.Edition,
            prev,
            next
        );
    }
}
