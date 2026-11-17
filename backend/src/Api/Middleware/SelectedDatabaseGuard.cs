using Api.Extensions;
using Api.V2;
using Application.AdminAuth;
using Application.Auth;
using Application.Identity;
using Application.Sync;
using Domain.Identity;
using Infrastructure.Persistence;
using Npgsql;

namespace Api.Middleware;

/// <summary>
/// V2 mode never falls back to legacy user handlers or accepts a reset/deleted account's JWT. A private
/// route or a write without <see cref="V2SelectedRoute"/> is gone in V2 (410 <c>gone_in_v2</c>, M5.1 Part C,
/// docs/internal/v2/m5-part-c-routes.md), logged with the caller's app version (v2-plan §5.4: the log ends
/// the old-build window); a route in <see cref="Pending"/> is still being ported (retryable 503).
/// </summary>
public sealed class SelectedDatabaseGuard(RequestDelegate next, DatabaseMode mode, ILogger<SelectedDatabaseGuard>? logger = null)
{
    public static readonly object AccountItemKey = new();

    /// <summary>
    /// <c>METHOD /pattern</c> of the legacy routes Part C ports to V2 in its stacked PRs. Each port marks its V2
    /// handler and removes its lines; empty, it goes.
    /// </summary>
    public static readonly IReadOnlySet<string> Pending = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "POST /me/books/clip",
    };

    /// <summary>The matched route as <c>METHOD /pattern</c> (the route table's form); the path when unrouted.</summary>
    public static string RouteOf(HttpContext http) =>
        $"{http.Request.Method} /{((http.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? http.Request.Path.Value)?.TrimStart('/')}";

    public async Task InvokeAsync(HttpContext http, IAuthService auth, IUserRepository users)
    {
        if (!mode.IsV2 || HttpMethods.IsOptions(http.Request.Method))
        {
            await next(http);
            return;
        }

        var endpoint = http.GetEndpoint();
        var path = http.Request.Path;
        var privatePath = path.StartsWithSegments("/me") || path.StartsWithSegments("/admin");
        var mutation = !HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method);
        if (endpoint is not null && (privatePath || mutation)
            && endpoint.Metadata.GetMetadata<V2SelectedRoute>() is null)
        {
            // Never write the wrong database: a route is ported (marked), pending (503) or gone (410).
            var route = RouteOf(http);
            if (path.StartsWithSegments("/me/v2") || Pending.Contains(route))
            {
                http.Response.StatusCode = 503;
                http.Response.Headers.RetryAfter = "60";
                if (path.StartsWithSegments("/me/v2"))
                    await http.Response.WriteAsJsonAsync(SyncResult.V2Unavailable.Body, http.RequestAborted);
                else
                    await http.Response.WriteAsJsonAsync(new { error = "v2_compatibility_pending" }, http.RequestAborted);
                return;
            }
            var appVersion = http.Request.Headers[AppVersionMiddleware.VersionHeader].ToString();
            logger?.LogInformation("Gone in V2: {Route} from app {AppVersion}, outcome 410",
                route, appVersion.Length > 0 ? appVersion : "none");
            http.Response.StatusCode = StatusCodes.Status410Gone;
            await http.Response.WriteAsJsonAsync(new { error = "gone_in_v2" }, http.RequestAborted);
            return;
        }

        try
        {
            if (IsAdminSessionPath(path))
            {
                var raw = http.Request.Cookies["admin_access_token"];
                var token = raw is null ? null : http.RequestServices.GetRequiredService<JwtTokens>().ValidateAdminAccessTokenIdentity(raw);
                if (token is not null)
                {
                    var account = await users.GetAsync(token.AdminId, http.RequestAborted);
                    if (account?.Role != UserAccount.AdminRole || ResetAfter(account, token.IssuedAt))
                    {
                        http.Response.StatusCode = 401;
                        return;
                    }
                }
            }
            else if (IsReaderSessionPath(path) && http.GetUserId(auth) is { } id)
            {
                var account = await users.GetAsync(id, http.RequestAborted);
                var token = http.GetAccessTokenIdentity(auth);
                // A gone account's token on /auth/guest falls through to a new guest (CreateGuestSession).
                if (account is null && path.StartsWithSegments("/auth/guest"))
                {
                    await next(http);
                    return;
                }
                if (account is null || (token is not null && ResetAfter(account, token.IssuedAt)))
                {
                    http.Response.StatusCode = 401;
                    return;
                }
                http.Items[AccountItemKey] = account;
            }
        }
        catch (NpgsqlException)
        {
            http.Response.StatusCode = 503;
            http.Response.Headers.RetryAfter = "30";
            await http.Response.WriteAsJsonAsync(SyncResult.V2Unavailable.Body, http.RequestAborted);
            return;
        }
        await next(http);
    }

    private static bool ResetAfter(UserAccount account, DateTimeOffset issuedAt) => account.CredentialsResetAt > issuedAt;

    private static bool IsReaderSessionPath(PathString path) => path.StartsWithSegments("/me")
        || path.StartsWithSegments("/auth/me")
        || path.StartsWithSegments("/auth/guest")
        || path.StartsWithSegments("/auth/device/approve") || path.StartsWithSegments("/auth/device/deny")
        || path.StartsWithSegments("/oauth/authorize/approve") || path.StartsWithSegments("/oauth/authorize/deny")
        || path.StartsWithSegments("/oauth/token-status");

    private static bool IsAdminSessionPath(PathString path) => path.StartsWithSegments("/admin")
        && !path.StartsWithSegments("/admin/auth/login") && !path.StartsWithSegments("/admin/auth/refresh")
        && !path.StartsWithSegments("/admin/auth/logout");
}
