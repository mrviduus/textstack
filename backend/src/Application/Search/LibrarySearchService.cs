using Application.Common.Interfaces;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using TextStack.Search.Abstractions;
using TextStack.Search.Contracts;
using TextStack.Search.Enums;

namespace Application.Search;

/// <summary>
/// One catalog hit surfaced to the Librarian agent (AI-Agent-3). The shape the agent reasons + post-filters
/// over: identity (<see cref="EditionId"/>/<see cref="Slug"/>), title + authors, the genres + language it
/// actually carries, and an aggregate <see cref="WordCount"/> (the only length signal catalog editions have —
/// editions have NO year/page columns, so <see cref="Year"/>/<see cref="Pages"/> are surfaced only when known,
/// which for the catalog is "not stored"). <see cref="ApproxPages"/> derives a rough page estimate from the
/// word count (≈275 words/page) so the agent can honor a "under N pages" constraint deterministically.
/// </summary>
public sealed record LibraryBook(
    Guid EditionId,
    string Slug,
    string Title,
    IReadOnlyList<string> Authors,
    IReadOnlyList<string> Genres,
    string Language,
    int? WordCount,
    int? Year,
    int? Pages)
{
    private const int WordsPerPage = 275;

    /// <summary>Rough page estimate from the word count when an explicit page count is absent (≈275 w/page).</summary>
    public int? ApproxPages => Pages ?? (WordCount is { } w and > 0 ? Math.Max(1, w / WordsPerPage) : null);
}

/// <summary>
/// The shared library-search seam behind <c>search_library</c>. It runs the existing catalog search
/// (pure FTS, <see cref="ISearchProvider"/>) — the semantic half rode on editions.embedding and went with
/// the chunks — collapses the chapter-level hits to
/// distinct editions, then ENRICHES each with the metadata the agent needs to post-filter (authors, genres,
/// language, aggregate word count) in ONE batched DB query. No new index, no new ranking: this is a thin
/// projection over what the catalog already returns + stores, so the agent's "books like X / about Y under N
/// pages" reasoning runs over real, retrieved rows (never invented).
/// </summary>
public sealed class LibrarySearchService(
    ISearchProvider searchProvider,
    IAppDbContext db)
{
    /// <summary>Hard cap on results returned to the agent — keeps the tool observation inside the prompt budget.</summary>
    public const int MaxResults = 12;

    /// <summary>
    /// Keyword (FTS) catalog search. Returns up to <paramref name="limit"/> distinct editions enriched for
    /// constraint filtering. <paramref name="language"/> narrows the FTS query language when supplied.
    /// </summary>
    public Task<IReadOnlyList<LibraryBook>> SearchAsync(
        string query, Guid siteId, string? language, int limit, CancellationToken ct) =>
        RunAsync(query, siteId, language, limit, ct);

    private async Task<IReadOnlyList<LibraryBook>> RunAsync(
        string query, Guid siteId, string? language, int limit, CancellationToken ct)
    {
        var capped = Math.Clamp(limit, 1, MaxResults);
        var request = new SearchRequest(
            Query: query,
            SiteId: siteId,
            Language: ParseLanguage(language),
            Offset: 0,
            Limit: capped,
            IncludeHighlights: false);

        var result = await searchProvider.SearchAsync(request, ct);

        // Collapse chapter-level hits to distinct editions, preserving the search rank order (the first hit
        // for an edition wins its position).
        var orderedEditionIds = new List<Guid>();
        var seen = new HashSet<Guid>();
        foreach (var hit in result.Hits)
        {
            var editionId = EditionIdOf(hit);
            if (editionId == Guid.Empty || !seen.Add(editionId))
                continue;
            orderedEditionIds.Add(editionId);
            if (orderedEditionIds.Count >= capped)
                break;
        }

        if (orderedEditionIds.Count == 0)
            return [];

        var enriched = await EnrichAsync(orderedEditionIds, siteId, ct);

        // Re-project in the search's rank order (the DB query returns rows in arbitrary order).
        return orderedEditionIds
            .Where(enriched.ContainsKey)
            .Select(id => enriched[id])
            .ToList();
    }

    /// <summary>
    /// Batched metadata fetch for the hit editions: title/slug/language + authors (ordered) + genres +
    /// aggregate chapter word count. Only Published editions on this site are returned, so a just-unpublished
    /// edition silently drops out (the agent never recommends a book that isn't live).
    /// </summary>
    private async Task<Dictionary<Guid, LibraryBook>> EnrichAsync(
        IReadOnlyList<Guid> editionIds, Guid siteId, CancellationToken ct)
    {
        var rows = await db.Editions
            .AsNoTracking()
            .Where(e => e.Status == EditionStatus.Published
                        && editionIds.Contains(e.Id))
            .Select(e => new
            {
                e.Id,
                e.Slug,
                e.Title,
                e.Language,
                Authors = e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .ToList(),
                Genres = e.Genres.Select(g => g.Name).ToList(),
                WordCount = e.Chapters.Sum(c => (int?)c.WordCount),
            })
            .ToListAsync(ct);

        return rows.ToDictionary(
            r => r.Id,
            r => new LibraryBook(
                EditionId: r.Id,
                Slug: r.Slug,
                Title: r.Title,
                Authors: r.Authors,
                Genres: r.Genres,
                Language: r.Language,
                WordCount: r.WordCount,
                // Catalog editions carry no first-publication year nor page-count column — surfaced as null
                // (honest: the agent must not invent them; length filtering uses the word-count estimate).
                Year: null,
                Pages: null));
    }

    private static SearchLanguage ParseLanguage(string? language) =>
        string.Equals(language?.Trim(), "en", StringComparison.OrdinalIgnoreCase)
            ? SearchLanguage.En
            : SearchLanguage.Auto;

    private static Guid EditionIdOf(SearchHit hit) =>
        hit.Metadata.TryGetValue("editionId", out var v) && v is Guid g ? g : Guid.Empty;
}
