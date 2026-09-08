using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class UserBookSearchService(IAppDbContext db)
{
    public const int MaxResults = 50;

    public async Task<IReadOnlyList<UserBookSearchHit>> SearchAsync(
        Guid userId, string query, IEnumerable<string>? tags, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query)) return Array.Empty<UserBookSearchHit>();

        var tagsArray = (tags ?? Array.Empty<string>())
            .Select(t => t.Trim().ToLowerInvariant())
            .Where(t => t.Length > 0)
            .Distinct()
            .ToArray();

        // websearch_to_tsquery handles user-typed query strings safely (quoted phrases, OR, -negation).
        // ts_headline returns excerpt with <mark>...</mark> around hits for direct UI rendering.
        var hasTagFilter = tagsArray.Length > 0;
        // Column aliases are snake_case, and that is load-bearing. The context is built with
        // UseSnakeCaseNamingConvention, and the convention applies to the SqlQueryRaw row type too:
        // EF looks for `chapter_slug`, not `ChapterSlug`. Aliased in PascalCase the query throws
        // "The required column 'chapter_slug' was not present in the results of a 'FromSql'
        // operation" on every single call — which is what it did, silently, because the only caller
        // renders an empty result on failure.
        var sql = $@"
            SELECT
                ub.id AS id,
                ub.title AS title,
                ub.author AS author,
                ub.cover_path AS cover_path,
                ub.language AS language,
                MAX(ts_rank(uc.search_vector, q))::float8 AS rank,
                (array_agg(
                    ts_headline('english', uc.plain_text, q, 'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MinWords=15,MaxWords=30,ShortWord=2')
                    ORDER BY ts_rank(uc.search_vector, q) DESC
                ))[1] AS excerpt,
                (array_agg(uc.slug ORDER BY ts_rank(uc.search_vector, q) DESC))[1] AS chapter_slug
            FROM user_books ub
            JOIN user_chapters uc ON uc.user_book_id = ub.id
            CROSS JOIN websearch_to_tsquery('english', {{0}}) q
            WHERE ub.user_id = {{1}}
              AND uc.search_vector @@ q
              {(hasTagFilter ? "AND ub.tags @> {2}" : string.Empty)}
            GROUP BY ub.id
            ORDER BY rank DESC
            LIMIT {MaxResults};
        ";

        var parameters = hasTagFilter
            ? new object[] { query, userId, tagsArray }
            : new object[] { query, userId };

        var rows = await db.Database
            .SqlQueryRaw<UserBookSearchRow>(sql, parameters)
            .ToListAsync(ct);

        return rows.Select(r => new UserBookSearchHit(
            r.Id, r.Title, r.Author, r.CoverPath, r.Language, r.Rank, r.Excerpt, r.ChapterSlug)).ToList();
    }

    public sealed record UserBookSearchRow(
        Guid Id, string Title, string? Author, string? CoverPath, string Language,
        double Rank, string? Excerpt, string? ChapterSlug);
}

public sealed record UserBookSearchHit(
    Guid Id, string Title, string? Author, string? CoverPath, string Language,
    double Rank, string? Excerpt, string? ChapterSlug);
