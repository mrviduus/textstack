using Application.Common.Interfaces;

namespace Api.Sites;

/// <summary>
/// The legacy /me handlers' site id: the single site (ADR-007), the same id the EF query filters key on.
/// Goes with those handlers (M6 B2); the host lookup it replaced went in B1.
/// </summary>
public static class HttpContextExtensions
{
    public static Guid GetSiteId(this HttpContext context) =>
        context.RequestServices.GetRequiredService<ICurrentSite>().Id;
}
