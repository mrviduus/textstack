using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.Books;
using Contracts.Common;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.Books;

public class BookService(IAppDbContext db)
{
    public async Task<PaginatedResult<BookListDto>> GetBooksAsync(
        Guid siteId, int offset, int limit, string? language,
        string? search, string? genreSlug, string? sort, CancellationToken ct)
    {
        var query = db.Editions
            .Where(e => e.Status == EditionStatus.Published)
            // Only show books with at least one chapter
            .Where(e => e.Chapters.Any())
            .AsQueryable();

        if (!string.IsNullOrEmpty(language))
            query = query.Where(e => e.Language == language);

        if (!string.IsNullOrEmpty(search))
        {
            var term = search.ToLower();
            query = query.Where(e =>
                e.Title.ToLower().Contains(term) ||
                e.EditionAuthors.Any(ea => ea.Author.Name.ToLower().Contains(term)));
        }

        if (!string.IsNullOrEmpty(genreSlug))
            query = query.Where(e => e.Genres.Any(g => g.Slug == genreSlug));

        var total = await query.CountAsync(ct);

        query = sort switch
        {
            "title" => query.OrderBy(e => e.Title),
            "oldest" => query.OrderBy(e => e.PublishedAt ?? e.CreatedAt),
            "recent" => query.OrderByDescending(e => e.PublishedAt ?? e.CreatedAt),
            // "popular" and the default: curated shelf by rank, then newest.
            _ => query
                .OrderBy(e => e.FeaturedRank == null)
                .ThenBy(e => e.FeaturedRank)
                .ThenByDescending(e => e.PublishedAt ?? e.CreatedAt)
        };

        var books = await query
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
                    .ToList(),
                e.FeaturedRank
            ))
            .ToListAsync(ct);

        return new PaginatedResult<BookListDto>(total, books);
    }

    /// <summary>
    /// Replaces the whole featured shelf: every edition loses its rank, then the given
    /// slugs (published only) get 1..N in order. One SaveChanges = one transaction.
    /// </summary>
    public async Task<ReplaceFeaturedResult> ReplaceFeaturedAsync(IReadOnlyList<string> slugs, CancellationToken ct)
    {
        var wanted = slugs.Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToList();

        var editions = await db.Editions
            .Where(e => e.FeaturedRank != null
                || (e.Status == EditionStatus.Published && wanted.Contains(e.Slug)))
            .ToListAsync(ct);

        foreach (var e in editions)
            e.FeaturedRank = null;

        var applied = new List<string>();
        var notFound = new List<string>();
        foreach (var slug in wanted)
        {
            var matches = editions.Where(e => e.Slug == slug && e.Status == EditionStatus.Published).ToList();
            if (matches.Count == 0)
            {
                notFound.Add(slug);
                continue;
            }
            applied.Add(slug);
            foreach (var e in matches)
                e.FeaturedRank = applied.Count;
        }

        await db.SaveChangesAsync(ct);
        return new ReplaceFeaturedResult(applied, notFound);
    }

    public async Task<BookDetailDto?> GetBookAsync(Guid siteId, string slug, string language, CancellationToken ct)
    {
        var result = await db.Editions
            .Where(e => e.Slug == slug && e.Language == language && e.Status == EditionStatus.Published)
            .Select(e => new
            {
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                e.Description,
                e.CoverPath,
                e.PublishedAt,
                e.IsPublicDomain,
                e.Indexable,
                e.SeoTitle,
                e.SeoDescription,
                e.SeoRelevanceText,
                e.SeoThemesJson,
                e.SeoFaqsJson,
                e.TocJson,
                Work = new WorkDto(e.Work.Id, e.Work.Slug),
                Chapters = e.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new ChapterSummaryDto(
                        c.Id,
                        c.ChapterNumber,
                        c.Slug,
                        c.Title,
                        c.WordCount
                    ))
                    .ToList(),
                OtherEditions = e.Work.Editions
                    .Where(oe => oe.Id != e.Id && oe.Status == EditionStatus.Published)
                    .Select(oe => new EditionSummaryDto(oe.Id, oe.Slug, oe.Language, oe.Title))
                    .ToList(),
                Authors = e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new BookAuthorDto(
                        ea.Author.Id,
                        ea.Author.Slug,
                        ea.Author.Name,
                        ea.Role.ToString()
                    ))
                    .ToList(),
                Genres = e.Genres
                    .Select(g => new BookGenreDto(g.Id, g.Slug, g.Name))
                    .ToList(),
                AuthorIds = e.EditionAuthors.Select(ea => ea.AuthorId).ToList()
            })
            .FirstOrDefaultAsync(ct);

        if (result is null)
            return null;

        // More books by same author(s)
        var moreByAuthor = await db.Editions
            .Where(e => e.Id != result.Id
                && e.Language == result.Language
                && e.Status == EditionStatus.Published
                && e.Chapters.Any()
                && e.EditionAuthors.Any(ea => result.AuthorIds.Contains(ea.AuthorId)))
            .OrderByDescending(e => e.PublishedAt ?? e.CreatedAt)
            .Take(6)
            .Select(e => new RelatedBookDto(e.Id, e.Slug, e.Title, e.CoverPath))
            .ToListAsync(ct);

        // Deserialize ToC from JSON
        IReadOnlyList<TocEntryDto>? toc = null;
        if (!string.IsNullOrEmpty(result.TocJson))
        {
            try
            {
                toc = JsonSerializer.Deserialize<List<TocEntryDto>>(result.TocJson, Common.JsonDefaults.Options);
            }
            catch
            {
                // Ignore deserialization errors
            }
        }

        return new BookDetailDto(
            result.Id,
            result.Slug,
            result.Title,
            result.Language,
            result.Description,
            result.CoverPath,
            result.PublishedAt,
            result.IsPublicDomain,
            result.Indexable,
            result.SeoTitle,
            result.SeoDescription,
            result.SeoRelevanceText,
            result.SeoThemesJson,
            result.SeoFaqsJson,
            result.Work,
            result.Chapters,
            result.OtherEditions,
            result.Authors,
            result.Genres,
            moreByAuthor,
            toc
        );
    }

    public async Task<string?> FindBookLanguageAsync(Guid siteId, string slug, CancellationToken ct)
    {
        return await db.Editions
            .Where(e => e.Slug == slug && e.Status == EditionStatus.Published)
            .Select(e => e.Language)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<ChapterDto?> GetChapterAsync(
        Guid siteId, string bookSlug, string chapterSlug, string language, CancellationToken ct)
    {
        var chapter = await db.Chapters
            .Where(c => c.Edition.Slug == bookSlug
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

        // Both neighbours in one round trip.
        var neighbours = await db.Chapters
            .Where(n => n.EditionId == chapter.EditionId
                && (n.ChapterNumber == chapter.ChapterNumber - 1 || n.ChapterNumber == chapter.ChapterNumber + 1))
            .Select(n => new { n.ChapterNumber, Nav = new ChapterNavDto(n.Slug, n.Title) })
            .ToListAsync(ct);
        var prev = neighbours.FirstOrDefault(n => n.ChapterNumber < chapter.ChapterNumber)?.Nav;
        var next = neighbours.FirstOrDefault(n => n.ChapterNumber > chapter.ChapterNumber)?.Nav;

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
