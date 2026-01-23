/**
 * PostgreSQL Full-Text Search Provider - Interview Demo Version
 *
 * Key concepts:
 * 1. Strategy Pattern: ISearchProvider abstraction allows swapping search backends
 * 2. Dependency Injection: connectionFactory, queryBuilder, textAnalyzer injected
 * 3. Hybrid search: combines FTS (content) + LIKE (title/author) + pg_trgm (fuzzy)
 * 4. SQL injection prevention via parameterized queries
 */

using System.Data;
using Dapper;
using TextStack.Search.Abstractions;
using TextStack.Search.Contracts;
using TextStack.Search.Enums;

namespace TextStack.Search.Providers.PostgresFts;

public sealed class PostgresSearchProvider : ISearchProvider
{
    // ════════════════════════════════════════════════════════════
    // DEPENDENCIES (injected via constructor)
    // ════════════════════════════════════════════════════════════

    private readonly Func<IDbConnection> _connectionFactory;  // DB connection factory
    private readonly IQueryBuilder _queryBuilder;             // Builds tsquery from text
    private readonly ITextAnalyzer _textAnalyzer;             // Normalizes/analyzes text
    private readonly HighlightOptions _highlightOptions;      // ts_headline config
    private readonly float _fuzzyThreshold;                   // pg_trgm similarity threshold

    public PostgresSearchProvider(
        Func<IDbConnection> connectionFactory,
        IQueryBuilder queryBuilder,
        ITextAnalyzer textAnalyzer,
        HighlightOptions? highlightOptions = null,
        float fuzzyThreshold = 0.3f)
    {
        _connectionFactory = connectionFactory;
        _queryBuilder = queryBuilder;
        _textAnalyzer = textAnalyzer;
        _highlightOptions = highlightOptions ?? HighlightOptions.Default;
        _fuzzyThreshold = fuzzyThreshold;
    }

    // ════════════════════════════════════════════════════════════
    // FULL-TEXT SEARCH
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Hybrid search combining 4 strategies:
    /// 1. LIKE match on title/author (exact substring)
    /// 2. pg_trgm fuzzy match on title (typo-tolerant)
    /// 3. pg_trgm fuzzy match on author (typo-tolerant)
    /// 4. PostgreSQL FTS on chapter content (stemming, ranking)
    /// </summary>
    public async Task<SearchResult> SearchAsync(SearchRequest request, CancellationToken ct = default)
    {
        // ─── Guard Clauses ──────────────────────────────────────
        if (string.IsNullOrWhiteSpace(request.Query))
            return SearchResult.Empty;

        // ─── Prepare Search Components ──────────────────────────
        var ftsConfig = _textAnalyzer.GetFtsConfig(request.Language);    // 'english', 'ukrainian'
        var tsQuery = _queryBuilder.BuildQuery(request.Query, request.Language);  // 'word1 & word2'
        var normalizedQuery = _textAnalyzer.Normalize(request.Query);    // lowercase, trim

        // Need valid query for either FTS or LIKE
        if (string.IsNullOrEmpty(tsQuery) && string.IsNullOrEmpty(normalizedQuery))
            return SearchResult.Empty;

        using var connection = _connectionFactory();

        // ─── Build LIKE Patterns ────────────────────────────────
        // Escape special chars: % _ \
        var escapedQuery = EscapeLikePattern(normalizedQuery ?? "");
        var titlePattern = "%" + escapedQuery + "%";   // contains
        var authorPattern = "%" + escapedQuery + "%";  // contains

        // ─── Count Total Matches ────────────────────────────────
        // Union of all 4 strategies, deduplicated
        var countSql = @"
            SELECT COUNT(*) FROM (
                -- Strategy 1: LIKE match on title/author
                SELECT id FROM (
                    SELECT DISTINCT ON (e.id) c.id
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND (lower(e.title) LIKE @TitlePattern OR EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND lower(a.name) LIKE @AuthorPattern))
                    ORDER BY e.id, c.chapter_number
                ) metadata_matches
                UNION
                -- Strategy 2: Fuzzy title match (pg_trgm similarity)
                SELECT id FROM (
                    SELECT DISTINCT ON (e.id) c.id
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND similarity(lower(e.title), @NormalizedQuery) > @FuzzyThreshold
                    ORDER BY e.id, c.chapter_number
                ) fuzzy_title_matches
                UNION
                -- Strategy 3: Fuzzy author match
                SELECT id FROM (
                    SELECT DISTINCT ON (e.id) c.id
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND similarity(lower(a.name), @NormalizedQuery) > @FuzzyThreshold)
                    ORDER BY e.id, c.chapter_number
                ) fuzzy_author_matches
                UNION
                -- Strategy 4: FTS on chapter content
                SELECT c.id
                FROM chapters c
                INNER JOIN editions e ON c.edition_id = e.id
                WHERE e.site_id = @SiteId
                  AND e.status = 1
                  AND @TsQuery != ''
                  AND c.search_vector @@ to_tsquery(@FtsConfig::regconfig, @TsQuery)
            ) combined";

        var totalCount = await connection.ExecuteScalarAsync<int>(
            new CommandDefinition(countSql, new
            {
                request.SiteId,
                FtsConfig = ftsConfig,
                TsQuery = tsQuery ?? "",
                TitlePattern = titlePattern,
                AuthorPattern = authorPattern,
                NormalizedQuery = normalizedQuery ?? "",
                FuzzyThreshold = _fuzzyThreshold
            }, cancellationToken: ct));

        if (totalCount == 0)
            return SearchResult.Empty;

        // ─── Fetch Results with Scoring ─────────────────────────
        // Different strategies get different base scores:
        // - LIKE match: 10.0 (exact match = highest)
        // - Fuzzy title: similarity * 8.0
        // - Fuzzy author: similarity * 6.0
        // - FTS content: ts_rank (typically 0-1)

        var highlightExpr = request.IncludeHighlights && !string.IsNullOrEmpty(tsQuery)
            ? $"ts_headline(@FtsConfig::regconfig, c.plain_text, to_tsquery(@FtsConfig::regconfig, @TsQuery), '{_highlightOptions.ToOptionsString()}')"
            : "NULL";

        var searchSql = $@"
            SELECT * FROM (
                -- Strategy 1: LIKE match (score = 10.0)
                SELECT * FROM (
                    SELECT DISTINCT ON (e.id)
                        c.id AS ChapterId,
                        c.slug AS ChapterSlug,
                        c.title AS ChapterTitle,
                        c.chapter_number AS ChapterNumber,
                        e.id AS EditionId,
                        e.slug AS EditionSlug,
                        e.title AS EditionTitle,
                        e.language AS Language,
                        (SELECT string_agg(a.name, ', ' ORDER BY ea.""order"") FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id) AS Authors,
                        e.cover_path AS CoverPath,
                        10.0::float8 AS Score,
                        NULL::text AS Headline
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND (lower(e.title) LIKE @TitlePattern OR EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND lower(a.name) LIKE @AuthorPattern))
                    ORDER BY e.id, c.chapter_number
                ) metadata_matches

                UNION ALL

                -- Strategy 2: Fuzzy title (score = similarity * 8.0)
                SELECT * FROM (
                    SELECT DISTINCT ON (e.id)
                        c.id AS ChapterId,
                        c.slug AS ChapterSlug,
                        c.title AS ChapterTitle,
                        c.chapter_number AS ChapterNumber,
                        e.id AS EditionId,
                        e.slug AS EditionSlug,
                        e.title AS EditionTitle,
                        e.language AS Language,
                        (SELECT string_agg(a.name, ', ' ORDER BY ea.""order"") FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id) AS Authors,
                        e.cover_path AS CoverPath,
                        (similarity(lower(e.title), @NormalizedQuery) * 8.0)::float8 AS Score,
                        NULL::text AS Headline
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND similarity(lower(e.title), @NormalizedQuery) > @FuzzyThreshold
                    ORDER BY e.id, c.chapter_number
                ) fuzzy_title_matches

                UNION ALL

                -- Strategy 3: Fuzzy author (score = max similarity * 6.0)
                SELECT * FROM (
                    SELECT DISTINCT ON (e.id)
                        c.id AS ChapterId,
                        c.slug AS ChapterSlug,
                        c.title AS ChapterTitle,
                        c.chapter_number AS ChapterNumber,
                        e.id AS EditionId,
                        e.slug AS EditionSlug,
                        e.title AS EditionTitle,
                        e.language AS Language,
                        (SELECT string_agg(a.name, ', ' ORDER BY ea.""order"") FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id) AS Authors,
                        e.cover_path AS CoverPath,
                        (COALESCE((SELECT MAX(similarity(lower(a.name), @NormalizedQuery)) FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id), 0) * 6.0)::float8 AS Score,
                        NULL::text AS Headline
                    FROM editions e
                    INNER JOIN chapters c ON c.edition_id = e.id
                    WHERE e.site_id = @SiteId
                      AND e.status = 1
                      AND EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND similarity(lower(a.name), @NormalizedQuery) > @FuzzyThreshold)
                    ORDER BY e.id, c.chapter_number
                ) fuzzy_author_matches

                UNION ALL

                -- Strategy 4: FTS content (score = ts_rank)
                SELECT
                    c.id AS ChapterId,
                    c.slug AS ChapterSlug,
                    c.title AS ChapterTitle,
                    c.chapter_number AS ChapterNumber,
                    e.id AS EditionId,
                    e.slug AS EditionSlug,
                    e.title AS EditionTitle,
                    e.language AS Language,
                    (SELECT string_agg(a.name, ', ' ORDER BY ea.""order"") FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id) AS Authors,
                    e.cover_path AS CoverPath,
                    ts_rank(c.search_vector, to_tsquery(@FtsConfig::regconfig, @TsQuery))::float8 AS Score,
                    {highlightExpr}::text AS Headline
                FROM chapters c
                INNER JOIN editions e ON c.edition_id = e.id
                WHERE e.site_id = @SiteId
                  AND e.status = 1
                  AND @TsQuery != ''
                  AND c.search_vector @@ to_tsquery(@FtsConfig::regconfig, @TsQuery)
            ) combined
            ORDER BY Score DESC
            OFFSET @Offset
            LIMIT @Limit";

        var rows = await connection.QueryAsync<SearchRow>(
            new CommandDefinition(searchSql, new
            {
                request.SiteId,
                FtsConfig = ftsConfig,
                TsQuery = tsQuery ?? "",
                TitlePattern = titlePattern,
                AuthorPattern = authorPattern,
                NormalizedQuery = normalizedQuery ?? "",
                FuzzyThreshold = _fuzzyThreshold,
                request.Offset,
                request.Limit
            }, cancellationToken: ct));

        var hits = rows.Select(r => MapToSearchHit(r, request.IncludeHighlights)).ToList();
        return SearchResult.FromHits(hits, totalCount);
    }

    // ════════════════════════════════════════════════════════════
    // AUTOCOMPLETE SUGGESTIONS
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Autocomplete combining prefix match + fuzzy match
    /// Used for search-as-you-type dropdown
    /// </summary>
    public async Task<IReadOnlyList<Suggestion>> SuggestAsync(
        string prefix,
        Guid siteId,
        int limit = 10,
        CancellationToken ct = default)
    {
        // ─── Guard Clauses ──────────────────────────────────────
        if (string.IsNullOrWhiteSpace(prefix) || prefix.Length < 2)
            return [];

        var normalizedPrefix = _textAnalyzer.Normalize(prefix);
        if (string.IsNullOrEmpty(normalizedPrefix))
            return [];

        using var connection = _connectionFactory();

        // ─── Hybrid Suggest Query ───────────────────────────────
        // Combines:
        // - Prefix LIKE for titles (starts with)
        // - Contains LIKE for authors
        // - pg_trgm similarity for typo tolerance
        var sql = @"
            SELECT DISTINCT ON (lower(e.title))
                e.title AS Text,
                e.slug AS Slug,
                (SELECT string_agg(a.name, ', ' ORDER BY ea.""order"") FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id) AS Authors,
                e.cover_path AS CoverPath,
                COUNT(c.id) AS ChapterCount,
                GREATEST(
                    similarity(lower(e.title), @NormalizedQuery),
                    COALESCE((SELECT MAX(similarity(lower(a.name), @NormalizedQuery)) FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id), 0)
                ) AS SimilarityScore
            FROM editions e
            LEFT JOIN chapters c ON c.edition_id = e.id
            WHERE e.site_id = @SiteId
              AND e.status = 1
              AND (
                  lower(e.title) LIKE @TitlePattern              -- prefix match
                  OR EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND lower(a.name) LIKE @AuthorPattern)   -- contains match
                  OR similarity(lower(e.title), @NormalizedQuery) > @FuzzyThreshold
                  OR EXISTS (SELECT 1 FROM edition_authors ea JOIN authors a ON a.id = ea.author_id WHERE ea.edition_id = e.id AND similarity(lower(a.name), @NormalizedQuery) > @FuzzyThreshold)
              )
            GROUP BY e.id, e.title, e.slug, e.cover_path
            ORDER BY lower(e.title), SimilarityScore DESC, ChapterCount DESC
            LIMIT @Limit";

        var escapedPrefix = EscapeLikePattern(normalizedPrefix);
        var titlePattern = escapedPrefix + "%";        // prefix match
        var authorPattern = "%" + escapedPrefix + "%"; // contains match

        var rows = await connection.QueryAsync<SuggestionRow>(
            new CommandDefinition(sql, new
            {
                SiteId = siteId,
                TitlePattern = titlePattern,
                AuthorPattern = authorPattern,
                NormalizedQuery = normalizedPrefix,
                FuzzyThreshold = _fuzzyThreshold,
                Limit = limit
            }, cancellationToken: ct));

        // ─── Normalize Scores ───────────────────────────────────
        // Score = chapterCount / maxChapterCount (more chapters = more relevant)
        var suggestions = rows.ToList();
        if (suggestions.Count == 0)
            return [];

        var maxCount = suggestions.Max(s => s.ChapterCount);
        return suggestions
            .Select(s => new Suggestion(
                s.Text,
                s.Slug,
                s.Authors,
                s.CoverPath,
                maxCount > 0 ? (double)s.ChapterCount / maxCount : 1.0))
            .ToList();
    }

    // ════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Escape SQL LIKE special characters to prevent injection
    /// </summary>
    private static string EscapeLikePattern(string pattern)
    {
        return pattern
            .Replace("\\", "\\\\")
            .Replace("%", "\\%")
            .Replace("_", "\\_");
    }

    /// <summary>
    /// Map database row to SearchHit domain object
    /// </summary>
    private static SearchHit MapToSearchHit(SearchRow row, bool includeHighlights)
    {
        var metadata = new Dictionary<string, object>
        {
            ["chapterId"] = row.ChapterId,
            ["chapterSlug"] = row.ChapterSlug ?? string.Empty,
            ["chapterTitle"] = row.ChapterTitle ?? string.Empty,
            ["chapterNumber"] = row.ChapterNumber,
            ["editionId"] = row.EditionId,
            ["editionSlug"] = row.EditionSlug ?? string.Empty,
            ["editionTitle"] = row.EditionTitle ?? string.Empty,
            ["language"] = row.Language ?? string.Empty,
            ["authors"] = row.Authors ?? string.Empty,
            ["coverPath"] = row.CoverPath ?? string.Empty
        };

        var highlights = includeHighlights && !string.IsNullOrEmpty(row.Headline)
            ? [PostgresHighlighter.ParseTsHeadlineResult(row.Headline, "content")]
            : Array.Empty<Highlight>();

        return new SearchHit(row.ChapterId.ToString(), row.Score, highlights, metadata);
    }

    // ════════════════════════════════════════════════════════════
    // INTERNAL DTOs (for Dapper mapping)
    // ════════════════════════════════════════════════════════════

    private sealed class SuggestionRow
    {
        public string Text { get; init; } = string.Empty;
        public string Slug { get; init; } = string.Empty;
        public string? Authors { get; init; }
        public string? CoverPath { get; init; }
        public int ChapterCount { get; init; }
        public double SimilarityScore { get; init; }
    }

    private sealed class SearchRow
    {
        public Guid ChapterId { get; init; }
        public string? ChapterSlug { get; init; }
        public string? ChapterTitle { get; init; }
        public int ChapterNumber { get; init; }
        public Guid EditionId { get; init; }
        public string? EditionSlug { get; init; }
        public string? EditionTitle { get; init; }
        public string? Language { get; init; }
        public string? Authors { get; init; }
        public string? CoverPath { get; init; }
        public double Score { get; init; }
        public string? Headline { get; init; }
    }
}
