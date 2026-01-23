using Domain.Enums;

namespace Application.SsgRebuild;

/// <summary>
/// Provides SSG routes for prerendering based on site content.
/// </summary>
public interface ISsgRouteProvider
{
    /// <summary>
    /// Gets routes to prerender for a site.
    /// </summary>
    /// <param name="siteId">Site to get routes for</param>
    /// <param name="mode">Rebuild mode (Full/Incremental/Specific)</param>
    /// <param name="bookSlugs">Optional book slugs for Specific mode</param>
    /// <param name="authorSlugs">Optional author slugs for Specific mode</param>
    /// <param name="genreSlugs">Optional genre slugs for Specific mode</param>
    /// <param name="ct">Cancellation token</param>
    /// <returns>List of routes with their types</returns>
    Task<List<SsgRoute>> GetRoutesAsync(
        Guid siteId,
        SsgRebuildMode mode,
        string[]? bookSlugs,
        string[]? authorSlugs,
        string[]? genreSlugs,
        CancellationToken ct);
}
