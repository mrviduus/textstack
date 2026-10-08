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
    /// <param name="ct">Cancellation token</param>
    /// <returns>List of routes with their types</returns>
    Task<List<SsgRoute>> GetRoutesAsync(
        Guid siteId,
        CancellationToken ct);
}
