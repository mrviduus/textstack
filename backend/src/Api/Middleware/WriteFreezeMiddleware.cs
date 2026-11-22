using Application.Sync;

namespace Api.Middleware;

/// <summary>
/// M5's HTTP write barrier. Enabled at process startup; operators must also stop external writers
/// and drain old requests before taking the cutover snapshot. This is not a database read-only switch.
/// </summary>
public sealed class WriteFreezeMiddleware(RequestDelegate next, IConfiguration configuration)
{
    public const string ConfigurationKey = "Maintenance:WriteFreeze";
    private readonly bool _enabled = configuration.GetValue<bool>(ConfigurationKey);

    public async Task InvokeAsync(HttpContext context)
    {
        if (_enabled && (!IsRead(context.Request.Method)
            // OAuth's browser entry creates a request (and may register a CIMD client), even on GET/HEAD.
            || (!HttpMethods.IsOptions(context.Request.Method)
                && context.Request.Path.StartsWithSegments("/oauth/authorize"))))
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.RetryAfter = "60";
            context.Response.Headers.CacheControl = "no-store";
            if (context.Request.Path.StartsWithSegments("/me/v2"))
                // Keep the sync protocol's existing retryable 503 envelope; no new client error code.
                await context.Response.WriteAsJsonAsync(SyncResult.Unavailable.Body, context.RequestAborted);
            else
                await context.Response.WriteAsJsonAsync(new { error = "write_frozen" }, context.RequestAborted);
            return;
        }

        await next(context);
    }

    private static bool IsRead(string method) =>
        HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
}
