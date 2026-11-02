using Api.Extensions;
using Application.Auth;

namespace Api.Middleware;

/// <summary>
/// ADR-024: <c>/me</c> and <c>/internal</c> fail closed by path, like <c>/admin</c>. A handler under
/// either prefix that forgets its check is a 401/403, not a leak.
///
/// <para><b>/me</b> → 401 when <see cref="ClaimsPrincipalExtensions.GetUserId"/> resolves nobody — the
/// same call every handler makes (bearer or cookie JWT, and the connect key / OAuth token
/// <see cref="McpKeyAuthMiddleware"/> left on <c>Items</c>), so the gate cannot refuse a request a
/// handler would accept. Handlers keep their own call: they need the id anyway. OPTIONS passes
/// (CORS preflight carries no credential).</para>
///
/// <para><b>/internal</b> → 403 unless <see cref="InternalNetwork.IsLocalRequest"/>. This is the only
/// check now; the handlers no longer repeat it.</para>
///
/// <para>Matched with <c>StartsWithSegments</c>, as the admin gate is: case-insensitive, whole
/// segments, on the path routing also matches (Kestrel has already removed dot segments and decoded
/// everything but <c>%2F</c>, and a <c>%2F</c> spelling matches no route either).</para>
///
/// <para>User routes that live OUTSIDE <c>/me</c> keep their handler checks and are not gated here:
/// <c>GET /auth/me</c>, <c>POST /auth/device/approve</c>, <c>POST /auth/device/deny</c>,
/// <c>POST /oauth/authorize/approve</c>, <c>POST /oauth/authorize/deny</c>,
/// <c>GET /oauth/token-status</c>. They are listed in <c>routes.public.txt</c>, so they stay visible.</para>
/// </summary>
public static class PathGates
{
    public static IApplicationBuilder UsePathGates(this IApplicationBuilder app)
    {
        app.UseWhen(
            ctx => ctx.Request.Path.StartsWithSegments("/me") && !HttpMethods.IsOptions(ctx.Request.Method),
            branch => branch.Use(async (ctx, next) =>
            {
                if (ctx.GetUserId(ctx.RequestServices.GetRequiredService<AuthService>()) is null)
                {
                    ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return;
                }
                await next(ctx);
            }));

        app.UseWhen(
            ctx => ctx.Request.Path.StartsWithSegments("/internal"),
            branch => branch.Use(async (ctx, next) =>
            {
                if (!InternalNetwork.IsLocalRequest(ctx))
                {
                    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }
                await next(ctx);
            }));

        return app;
    }
}
