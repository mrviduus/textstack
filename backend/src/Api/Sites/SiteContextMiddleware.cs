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

    private static readonly string[] SkipPaths = ["/admin", "/auth", "/health", "/openapi", "/scalar", "/debug"];

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "";

        // Skip site resolution for admin and infra routes
        if (SkipPaths.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            await _next(context);
            return;
        }

        // Dev mode: allow ?site= query param override
        var siteOverride = context.Request.Query["site"].FirstOrDefault();

        var host = !string.IsNullOrEmpty(siteOverride)
            ? $"{siteOverride}.localhost"
            : context.Request.Host.Host;

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
