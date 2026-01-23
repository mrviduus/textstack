/**
 * Search API Endpoints - Interview Demo Version
 *
 * Patterns demonstrated:
 * 1. Minimal API with endpoint grouping
 * 2. Dependency Injection (ISearchProvider)
 * 3. Input validation with early returns
 * 4. Clean DTO mapping
 */

using Api.Language;
using Api.Sites;
using Contracts.Common;
using Microsoft.AspNetCore.Mvc;
using TextStack.Search.Abstractions;
using TextStack.Search.Analyzers;
using TextStack.Search.Contracts;

namespace Api.Endpoints;

public static class SearchEndpoints
{
    /// <summary>
    /// Registers search routes under /search group
    /// Pattern: Minimal API with route grouping
    /// </summary>
    public static void MapSearchEndpoints(this WebApplication app)
    {
        // Group endpoints under /search prefix with OpenAPI tag
        var group = app.MapGroup("/search").WithTags("Search");

        // Two endpoints: full-text search and autocomplete suggestions
        group.MapGet("", Search).WithName("Search");
        group.MapGet("/suggest", Suggest).WithName("SearchSuggest");
    }

    /// <summary>
    /// Full-text search across book chapters
    /// Returns paginated results with optional text highlights
    /// </summary>
    private static async Task<IResult> Search(
        HttpContext httpContext,
        ISearchProvider searchProvider,  // Injected via DI
        [FromQuery] string q,             // Search query
        [FromQuery] int? limit,           // Page size (default 20, max 100)
        [FromQuery] int? offset,          // Skip N results
        [FromQuery] bool? highlight,      // Include text snippets?
        CancellationToken ct)
    {
        // ─── Input Validation ───────────────────────────────────
        // Early return pattern: validate before any processing
        if (string.IsNullOrWhiteSpace(q) || q.Length < 2)
            return Results.BadRequest(new { error = "Query must be at least 2 characters" });

        // ─── Extract Context ────────────────────────────────────
        // Site and language from request context (multitenancy)
        var siteId = httpContext.GetSiteId();
        var language = httpContext.GetLanguage();

        // ─── Normalize Parameters ───────────────────────────────
        // Clamp limit to prevent abuse (max 100)
        var take = Math.Min(limit ?? 20, 100);
        var skip = offset ?? 0;

        // ─── Build Request ──────────────────────────────────────
        // Detect search language for proper FTS configuration
        var searchLanguage = MultilingualAnalyzer.DetectFromCode(language);
        var request = new SearchRequest(
            q,
            siteId,
            searchLanguage,
            skip,
            take,
            highlight ?? false);

        // ─── Execute Search ─────────────────────────────────────
        var result = await searchProvider.SearchAsync(request, ct);

        // ─── Map to Response ────────────────────────────────────
        // Transform internal SearchHit to API DTO
        var items = result.Hits.Select(MapToSearchResultDto).ToList();
        return Results.Ok(new PaginatedResult<SearchResultDto>(result.TotalCount, items));
    }

    /// <summary>
    /// Autocomplete suggestions for search input
    /// Returns book titles/authors matching prefix
    /// </summary>
    private static async Task<IResult> Suggest(
        HttpContext httpContext,
        ISearchProvider searchProvider,
        [FromQuery] string q,
        [FromQuery] int? limit,
        CancellationToken ct)
    {
        // ─── Input Validation ───────────────────────────────────
        // Return empty array for short queries (not an error)
        if (string.IsNullOrWhiteSpace(q) || q.Length < 2)
            return Results.Ok(Array.Empty<SuggestionDto>());

        var siteId = httpContext.GetSiteId();
        var take = Math.Min(limit ?? 10, 20);  // Max 20 suggestions

        // ─── Execute Suggest ────────────────────────────────────
        var suggestions = await searchProvider.SuggestAsync(q, siteId, take, ct);

        // ─── Map to Response ────────────────────────────────────
        var items = suggestions
            .Select(s => new SuggestionDto(s.Text, s.Slug, s.Authors, s.CoverPath, s.Score))
            .ToList();

        return Results.Ok(items);
    }

    // ════════════════════════════════════════════════════════════
    // MAPPING HELPERS
    // ════════════════════════════════════════════════════════════

    /// <summary>
    /// Maps internal SearchHit to API response DTO
    /// Extracts metadata from dictionary into strongly-typed record
    /// </summary>
    private static SearchResultDto MapToSearchResultDto(SearchHit hit)
    {
        var meta = hit.Metadata;

        return new SearchResultDto(
            GetGuid(meta, "chapterId"),
            GetString(meta, "chapterSlug"),
            GetString(meta, "chapterTitle"),
            GetInt(meta, "chapterNumber"),
            new SearchEditionDto(
                GetGuid(meta, "editionId"),
                GetString(meta, "editionSlug"),
                GetString(meta, "editionTitle"),
                GetString(meta, "language"),
                GetString(meta, "authors"),
                GetString(meta, "coverPath")
            ),
            // Flatten highlights: [[frag1, frag2], [frag3]] → [frag1, frag2, frag3]
            hit.Highlights.SelectMany(h => h.Fragments).ToList()
        );
    }

    // Safe dictionary accessors with type conversion
    private static Guid GetGuid(IReadOnlyDictionary<string, object> meta, string key) =>
        meta.TryGetValue(key, out var value) && value is Guid g ? g : Guid.Empty;

    private static string GetString(IReadOnlyDictionary<string, object> meta, string key) =>
        meta.TryGetValue(key, out var value) ? value?.ToString() ?? "" : "";

    private static int GetInt(IReadOnlyDictionary<string, object> meta, string key) =>
        meta.TryGetValue(key, out var value) && value is int i ? i : 0;
}

// ════════════════════════════════════════════════════════════════
// RESPONSE DTOs
// Pattern: Immutable records for API responses
// ════════════════════════════════════════════════════════════════

/// <summary>
/// Single search result (a chapter match)
/// </summary>
public record SearchResultDto(
    Guid ChapterId,
    string? ChapterSlug,
    string? ChapterTitle,
    int ChapterNumber,
    SearchEditionDto Edition,
    IReadOnlyList<string>? Highlights = null
);

/// <summary>
/// Book edition metadata (nested in search result)
/// </summary>
public record SearchEditionDto(
    Guid Id,
    string Slug,
    string Title,
    string Language,
    string? Authors,
    string? CoverPath
);

/// <summary>
/// Autocomplete suggestion item
/// </summary>
public record SuggestionDto(
    string Text,
    string Slug,
    string? Authors,
    string? CoverPath,
    double Score
);
