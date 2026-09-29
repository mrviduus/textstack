namespace Api.Sites;

public class SiteContextMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ISiteResolver _resolver;

    public SiteContextMiddleware(RequestDelegate next, ISiteResolver resolver)
    {
        _next = next;
        _resolver = resolver;
    }

    private static readonly string[] SkipPaths = ["/admin", "/auth/", "/health", "/openapi", "/scalar", "/debug", "/storage", "/oauth/", "/.well-known/"];

    private static bool ShouldSkip(string path)
    {
        if (SkipPaths.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            return true;

        // Skip /books/{id}/assets/{assetId} - public resources don't need site context
        if (path.Contains("/assets/", StringComparison.OrdinalIgnoreCase) && path.StartsWith("/books/", StringComparison.OrdinalIgnoreCase))
            return true;

        return false;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "";

        // Skip site resolution for admin, infra routes, and public assets
        if (ShouldSkip(path))
        {
            await _next(context);
            return;
        }

        // Single-site (ADR-007): resolve strictly by request host. The legacy dev
        // `?site=` override was removed in R1b — it could resolve a SiteContext whose
        // Id diverged from the process-wide ICurrentSite.Id that the new EF global
        // query filters key on, silently yielding zero rows. The one seeded site's
        // host always resolves to SiteConstants.DefaultSiteId == ICurrentSite.Id.
        var host = context.Request.Host.Host;

        var siteContext = await _resolver.ResolveAsync(host, context.RequestAborted);

        if (siteContext is null)
        {
            // Unknown host → 404
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsync("Site not found");
            return;
        }

        context.Items["SiteContext"] = siteContext;

        await _next(context);
    }
}

public static class SiteContextMiddlewareExtensions
{
    public static IApplicationBuilder UseSiteContext(this IApplicationBuilder app)
    {
        return app.UseMiddleware<SiteContextMiddleware>();
    }
}
